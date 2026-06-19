// netlify/functions/analyze.js
// LoL プレイヤー特性診断 — Riot 公式 API プロキシ + 集計 + 診断エンジン
// 日本サーバー(JP1)運用。account-v1 / match-v5 は asia ルーティング、ランクは jp1。

const PLATFORM = "jp1";      // summoner / league (ランク)
const REGION = "asia";       // account-v1 / match-v5 (JPはasiaクラスタ)

// 解析対象にするキュー（サモナーズリフトのみ。ARAM等は性格判定が歪むので除外）
const SR_QUEUES = new Set([400, 420, 430, 440, 700]); // 通常Draft/ランクSolo/通常Blind/ランクFlex/Clash
const MATCH_COUNT = 30;      // 直近の取得試合数
const MIN_DURATION = 300;    // 5分未満はリメイク扱いで除外

// ロール別の基準値 [低い, 高い]。JPソロキューのおおよその目安（要キャリブレーション）。
// dmgShare=チームダメージ占有率, vision=視界/分, deaths=平均デス, obj=オブジェクト関与/試合,
// kills=平均キル, early=15分前テイクダウン比率, cs=分間CS, kp=キル関与率
const ROLE_BASELINES = {
  TOP:     { dmgShare: [0.18, 0.28], vision: [0.4, 0.9], deaths: [4, 8],   obj: [1, 3.5], kills: [3, 8], early: [0.20, 0.50], cs: [6.0, 8.5], kp: [0.45, 0.62] },
  JUNGLE:  { dmgShare: [0.15, 0.24], vision: [0.7, 1.4], deaths: [4, 8],   obj: [2.5, 6], kills: [3, 8], early: [0.30, 0.60], cs: [4.8, 6.5], kp: [0.55, 0.72] },
  MIDDLE:  { dmgShare: [0.22, 0.32], vision: [0.5, 1.0], deaths: [4, 8],   obj: [1, 3],   kills: [4, 9], early: [0.25, 0.55], cs: [6.5, 9.0], kp: [0.50, 0.68] },
  BOTTOM:  { dmgShare: [0.24, 0.34], vision: [0.4, 0.9], deaths: [4, 7.5], obj: [1, 3],   kills: [4, 9], early: [0.20, 0.50], cs: [6.8, 9.2], kp: [0.50, 0.66] },
  UTILITY: { dmgShare: [0.07, 0.15], vision: [1.4, 2.6], deaths: [5, 9],   obj: [1, 3.5], kills: [1, 4], early: [0.25, 0.55], cs: [0.8, 2.5], kp: [0.55, 0.72] },
  DEFAULT: { dmgShare: [0.14, 0.28], vision: [0.5, 1.6], deaths: [4, 8],   obj: [1.5, 5], kills: [3, 9], early: [0.25, 0.55], cs: [5.0, 8.0], kp: [0.50, 0.68] },
};

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
};

exports.handler = async (event) => {
  const key = process.env.RIOT_API_KEY;
  if (!key) {
    return resp(500, { error: "サーバーに RIOT_API_KEY が設定されていません。Netlify の環境変数を確認してください。" });
  }

  const q = event.queryStringParameters || {};
  const gameName = (q.gameName || "").trim();
  const tagLine = (q.tagLine || "").replace(/^#/, "").trim();
  if (!gameName || !tagLine) {
    return resp(400, { error: "Riot ID（名前とタグ）を入力してください。例：zaccident / omg" });
  }

  const riot = (host, path) =>
    fetch(`https://${host}.api.riotgames.com${path}`, { headers: { "X-Riot-Token": key } });

  try {
    // 1. Riot ID → PUUID
    const accRes = await riot(REGION,
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
    if (accRes.status === 404) return resp(404, { error: `「${gameName}#${tagLine}」が見つかりませんでした。Riot ID とタグを確認してください。` });
    if (accRes.status === 401 || accRes.status === 403) return resp(502, { error: "APIキーが無効か期限切れです。Riot の開発者ポータルでキーを更新してください。" });
    if (accRes.status === 429) return resp(429, { error: "Riot API のレート制限に達しました。少し待って再試行してください。" });
    if (!accRes.ok) return resp(502, { error: `アカウント取得に失敗しました (HTTP ${accRes.status})` });
    const account = await accRes.json();
    const puuid = account.puuid;

    // 2. 試合IDリスト
    const idsRes = await riot(REGION,
      `/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=${MATCH_COUNT}`);
    if (!idsRes.ok) return resp(502, { error: `試合リスト取得に失敗しました (HTTP ${idsRes.status})` });
    const matchIds = await idsRes.json();
    if (!Array.isArray(matchIds) || matchIds.length === 0) {
      return resp(404, { error: "直近の試合データが見つかりませんでした。" });
    }

    // 3. 各試合の詳細（順次取得：dev keyのレート制限内に収める）
    const matches = [];
    for (const id of matchIds) {
      const mRes = await riot(REGION, `/lol/match/v5/matches/${id}`);
      if (mRes.status === 429) break; // 制限に当たったらそこまでで集計
      if (mRes.ok) matches.push(await mRes.json());
    }

    // 4. ランク（任意）
    let rank = null;
    try {
      const lRes = await riot(PLATFORM, `/lol/league/v4/entries/by-puuid/${puuid}`);
      if (lRes.ok) {
        const entries = await lRes.json();
        const solo = entries.find((e) => e.queueType === "RANKED_SOLO_5x5") || entries[0];
        if (solo) rank = { tier: solo.tier, division: solo.rank, lp: solo.leaguePoints,
          wins: solo.wins, losses: solo.losses, queue: solo.queueType };
      }
    } catch (_) { /* ランクは取れなくても続行 */ }

    // 5. 集計 + 診断
    const result = analyze(puuid, matches);
    return resp(200, {
      riotId: `${account.gameName}#${account.tagLine}`,
      rank,
      ...result,
    });
  } catch (err) {
    return resp(500, { error: "サーバー内部エラー: " + (err && err.message ? err.message : String(err)) });
  }
};

// ---------------------------------------------------------------------------
// 集計 + 診断ロジック
// ---------------------------------------------------------------------------
function analyze(puuid, matches) {
  const games = [];
  for (const m of matches) {
    const info = m.info;
    if (!info) continue;
    if (!SR_QUEUES.has(info.queueId)) continue;
    if (info.gameDuration < MIN_DURATION) continue;

    const me = info.participants.find((p) => p.puuid === puuid);
    if (!me) continue;
    const myTeam = info.participants.filter((p) => p.teamId === me.teamId);
    const teamKills = sum(myTeam, "kills") || 1;
    const teamDmg = sum(myTeam, "totalDamageDealtToChampions") || 1;
    const mins = info.gameDuration / 60;
    const c = me.challenges || {};

    games.push({
      champion: me.championName,
      role: me.teamPosition || me.individualPosition || "",
      win: !!me.win,
      kills: me.kills, deaths: me.deaths, assists: me.assists,
      kp: c.killParticipation != null ? c.killParticipation : (me.kills + me.assists) / teamKills,
      dmgShare: c.teamDamagePercentage != null ? c.teamDamagePercentage : me.totalDamageDealtToChampions / teamDmg,
      csPerMin: ((me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0)) / mins,
      visionPerMin: c.visionScorePerMinute != null ? c.visionScorePerMinute : (me.visionScore || 0) / mins,
      soloKills: c.soloKills || 0,
      earlyTakedowns: c.takedownsBefore15Minutes != null ? c.takedownsBefore15Minutes : null,
      totalTakedowns: me.kills + me.assists,
      objectiveTakedowns:
        (c.dragonTakedowns || 0) + (c.baronTakedowns || 0) +
        (c.riftHeraldTakedowns || 0) + (me.turretTakedowns || 0),
      durationMin: mins,
    });
  }

  if (games.length === 0) {
    return { sampleSize: 0, error: "解析可能なサモナーズリフトの試合がありませんでした。" };
  }

  const n = games.length;
  const avg = (f) => games.reduce((s, g) => s + f(g), 0) / n;

  const avgKills = avg((g) => g.kills);
  const avgDeaths = avg((g) => g.deaths);
  const avgAssists = avg((g) => g.assists);
  const avgKP = avg((g) => g.kp);
  const avgDmgShare = avg((g) => g.dmgShare);
  const avgCs = avg((g) => g.csPerMin);
  const avgVision = avg((g) => g.visionPerMin);
  const avgObj = avg((g) => g.objectiveTakedowns);
  const avgDur = avg((g) => g.durationMin);
  const deathSd = stddev(games.map((g) => g.deaths));
  const winrate = games.filter((g) => g.win).length / n;

  // 序盤型度合い（15分前のテイクダウン比率 + 平均試合時間の短さ）
  const earlyRatio = (() => {
    const withEarly = games.filter((g) => g.earlyTakedowns != null && g.totalTakedowns > 0);
    if (withEarly.length === 0) return 0.5;
    return withEarly.reduce((s, g) => s + g.earlyTakedowns / g.totalTakedowns, 0) / withEarly.length;
  })();

  // チャンピオン別集計
  const byChamp = {};
  for (const g of games) {
    const k = g.champion;
    byChamp[k] = byChamp[k] || { champion: k, games: 0, wins: 0 };
    byChamp[k].games++;
    if (g.win) byChamp[k].wins++;
  }
  const champArr = Object.values(byChamp).map((c) => ({ ...c, winrate: c.wins / c.games }));
  champArr.sort((a, b) => b.games - a.games);
  const mostPlayed = champArr.slice(0, 3);
  const reliable = champArr.filter((c) => c.games >= 3);
  const best = reliable.slice().sort((a, b) => b.winrate - a.winrate)[0] || null;
  const worst = reliable.slice().sort((a, b) => a.winrate - b.winrate)[0] || null;
  const uniqueChamps = champArr.length;
  const topShare = mostPlayed.length ? mostPlayed[0].games / n : 0;

  // ロール分布
  const roleCount = {};
  for (const g of games) if (g.role) roleCount[g.role] = (roleCount[g.role] || 0) + 1;
  const mainRole = Object.entries(roleCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const base = ROLE_BASELINES[mainRole] || ROLE_BASELINES.DEFAULT;

  // --- 5軸スコア（0-100）。基準値はロール別（ROLE_BASELINES）で正規化 ---
  const axes = {
    tempo: scoreBetween(earlyRatio, base.early[0], base.early[1]) * 0.6 + scoreBetween(35 - avgDur, 35 - 32, 35 - 26) * 0.4, // 高い=序盤型
    role: scoreBetween(avgDmgShare, base.dmgShare[0], base.dmgShare[1]) * 0.6 + (100 - scoreBetween(avgVision, base.vision[0], base.vision[1])) * 0.4, // 高い=キャリー型
    risk: scoreBetween(avgDeaths, base.deaths[0], base.deaths[1]) * 0.6 + scoreBetween(deathSd, 1.5, 4) * 0.4, // 高い=ハイリスク
    pool: scoreBetween(topShare, 0.2, 0.6) * 0.5 + scoreBetween(8 - uniqueChamps, 8 - 12, 8 - 3) * 0.5, // 高い=スペシャリスト（ロール非依存）
    macro: scoreBetween(avgObj, base.obj[0], base.obj[1]) * 0.6 + (100 - scoreBetween(avgKills, base.kills[0], base.kills[1])) * 0.4, // 高い=マクロ型
  };
  for (const k in axes) axes[k] = clamp(Math.round(axes[k]), 0, 100);

  // --- 暫定タイプ判定（※summonertypeの20タイプは次ステップで差し込み） ---
  const type = decideType(axes);

  // --- 課題（弱点）テキスト：ロール別基準で判定 ---
  const weaknesses = [];
  if (avgVision < base.vision[0]) weaknesses.push("視界スコアがロール基準より低め。コントロールワードと敵ジャングルの視界管理を増やすとマップ判断が安定します。");
  if (avgDeaths > base.deaths[1]) weaknesses.push("平均デスがロール基準より多め。優位でない場面でのオーバーステイを減らすと安定します。");
  if (avgKP < base.kp[0]) weaknesses.push("キル関与率がロール基準より低め。仲間の動きに合わせた合流・ロームの判断が伸びしろです。");
  if (avgCs < base.cs[0]) weaknesses.push("分間CSがロール基準より低め。ウェーブ管理とラスヒ精度で安定したゴールド差を作れます。");
  if (deathSd > 3.5) weaknesses.push("試合ごとの成績のブレが大きめ。試合運びの再現性を高めるとレートが安定します。");
  if (weaknesses.length === 0) weaknesses.push("各指標が大きく崩れている点はありません。得意な勝ち筋をさらに磨くのが近道です。");

  return {
    sampleSize: n,
    winrate: round(winrate, 3),
    mainRole,
    stats: {
      kda: round((avgKills + avgAssists) / Math.max(avgDeaths, 1), 2),
      avgKills: round(avgKills, 1), avgDeaths: round(avgDeaths, 1), avgAssists: round(avgAssists, 1),
      killParticipation: round(avgKP, 3),
      damageShare: round(avgDmgShare, 3),
      csPerMin: round(avgCs, 1),
      visionPerMin: round(avgVision, 2),
      avgGameMin: round(avgDur, 1),
    },
    axes,
    type,
    champions: { mostPlayed, best, worst, uniqueChamps },
    weaknesses,
  };
}

// 暫定タイプ：5軸の最も尖った傾向からラベル付け（2〜3文字、世界観寄せ）
function decideType(a) {
  const lean = (v) => v - 50; // -50..+50
  const traits = [
    { name: "tempo", abs: Math.abs(lean(a.tempo)), hi: "強襲", lo: "大器" },
    { name: "role", abs: Math.abs(lean(a.role)), hi: "首魁", lo: "采配" },
    { name: "risk", abs: Math.abs(lean(a.risk)), hi: "刃境", lo: "盤石" },
    { name: "pool", abs: Math.abs(lean(a.pool)), hi: "専心", lo: "遊撃" },
    { name: "macro", abs: Math.abs(lean(a.macro)), hi: "謀略", lo: "闘魂" },
  ];
  traits.sort((x, y) => y.abs - x.abs);
  const primary = traits[0];
  const label = lean(a[primary.name]) >= 0 ? primary.hi : primary.lo;
  const blurb = {
    強襲: "序盤から主導権を握り、相手が整う前に試合を傾ける先制型。",
    大器: "中盤以降のスケールで勝つ、終盤を見据えた育成型。",
    首魁: "チームの火力を一身に背負い、自分で試合を決めにいくキャリー型。",
    采配: "視界と立ち回りで盤面を整える、味方を活かす司令塔型。",
    刃境: "リスクを取って大きな見返りを狙う、刃の上を歩くハイリスク型。",
    盤石: "崩れにくく一貫した試合運びで勝ち切る安定型。",
    専心: "限られた得意ピックを深く極めるスペシャリスト型。",
    遊撃: "状況に応じて幅広く持ち替える対応力のジェネラリスト型。",
    謀略: "オブジェクトとマップ全体で優位を作るマクロ型。",
    闘魂: "戦闘と撃ち合いで存在感を出すファイト型。",
  }[label];
  return { label, blurb, primaryAxis: primary.name };
}

// ---- helpers ----
function scoreBetween(v, lo, hi) { return clamp(((v - lo) / (hi - lo)) * 100, 0, 100); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sum(arr, key) { return arr.reduce((s, x) => s + (x[key] || 0), 0); }
function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}
function resp(statusCode, body) { return { statusCode, headers, body: JSON.stringify(body) }; }
