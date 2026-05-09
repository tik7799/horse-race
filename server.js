const { WebcastPushConnection } = require('tiktok-live-connector');
const WebSocket = require('ws');

const WS_PORT = 3001;
let TIKTOK_USERNAME = '';

const wss = new WebSocket.Server({ port: WS_PORT });
console.log('🐎 WebSocket server started on ws://localhost:' + WS_PORT);

const clients = new Set();

// ── TEAM MODE STATE ──
// userId → countryName (e.g. 'armenia', 'russia')
const userTeams = {};
// teamMode is controlled by the browser (HTML game)
// Server just tracks registrations and forwards gifts accordingly
let teamModeEnabled = false;

// Like count tracking — likeCount-ը TikTok-ում կուտակային է
// պահում ենք վերջին արժեքը, ուղարկում ենք տարբերությունը
const userLikeCounts = {};

// ── GIFT REGISTRATION MAP ──
// giftName (lowercase) → countryCode  e.g. { 'rose': 'armenia', 'sunglasses': 'russia' }
let giftRegistry = {};

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('🟢 Browser connected');
  ws.send(JSON.stringify({ type: 'status', msg: 'Bridge online' }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      // Browser sends username to connect TikTok
      if (msg.type === 'setUsername' && msg.username) {
        TIKTOK_USERNAME = msg.username;
        console.log('📝 Username: @' + msg.username);
        connectTikTok(msg.username);
      }

      // Browser tells server whether team mode is ON or OFF
      // Browser sends gift→country mapping
      if (msg.type === 'setGiftRegistry') {
        giftRegistry = msg.registry || {};
        console.log('🎁 Gift registry updated:', JSON.stringify(giftRegistry));
      }

      if (msg.type === 'setTeamMode') {
        teamModeEnabled = !!msg.enabled;
        console.log('👥 Team mode: ' + (teamModeEnabled ? 'ON' : 'OFF'));
        // Registrations-ը չջնջել — mode on անելուց հետո like-ները շարունակ հաշվվեն
      }

    } catch (e) {}
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach((ws) => {
    try { if (ws.readyState === 1) ws.send(msg); } catch (e) {}
  });
}

let tiktokConn = null;

function connectTikTok(username) {
  if (tiktokConn) {
    try { tiktokConn.disconnect(); } catch (e) {}
    tiktokConn = null;
  }

  console.log('🔗 Connecting to @' + username);
  broadcast({ type: 'status', msg: 'Connecting to @' + username + '...' });

  tiktokConn = new WebcastPushConnection(username, {
    processInitialData: false,
    enableExtendedGiftInfo: true,   // ← diamond_count-ի համար
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 2000,
  });

  tiktokConn.connect().then((state) => {
    console.log('✅ Connected! Room: ' + state.roomId);
    broadcast({ type: 'status', msg: '✅ Connected @' + username });
  }).catch((err) => {
    console.error('❌ Error: ' + err.message);
    broadcast({ type: 'status', msg: '❌ ' + err.message });
    setTimeout(() => connectTikTok(username), 10000);
  });

  // ── GIFT EVENT ──
  tiktokConn.on('gift', (data) => {
    if (data.giftType === 1 && !data.repeatEnd) return;

    const sender      = data.uniqueId;
    const giftName    = data.giftName    || 'Unknown';
    const repeatCount = data.repeatCount || 1;

    // TikTok diamond արժողությունը 1 gift-ի համար
    // 1 diamond = 1 kopek (TikTok-ի coin system)
    // Debug — տեслenk ves data-ы mej ka diamond info
    const _ei = data.extendedGiftInfo;
    const _gd = data.gift;
    console.log('🔍 RAW gift fields → diamondCount:' + data.diamondCount +
      ' | coin_count:' + data.coin_count +
      ' | gift.diamond_count:' + (_gd && _gd.diamond_count) +
      ' | extGift.diamond_count:' + (_ei && _ei.diamond_count) +
      ' | giftType:' + data.giftType +
      ' | describe:' + JSON.stringify(Object.keys(data))
    );

    const diamondPerGift =
      (_ei  && _ei.diamond_count  > 0 ? _ei.diamond_count  : 0) ||
      (_gd  && _gd.diamond_count  > 0 ? _gd.diamond_count  : 0) ||
      (data.diamondCount > 0 ? data.diamondCount : 0)            ||
      (data.coin_count   > 0 ? data.coin_count   : 0)            ||
      0;

    const totalDiamonds = diamondPerGift * repeatCount;

    console.log(
      '🎁 ' + giftName +
      ' x' + repeatCount +
      ' | 💎 ' + diamondPerGift + '/gift → ' + totalDiamonds + ' total' +
      ' | from @' + sender
    );

    // ── GIFT AUTO-REGISTRATION ──
    // giftRegistry-ն browser-ից ստացված mapping է (setGiftRegistry)
    // teamModeEnabled-ի կախում չկա — gift-ն ինքն ռեգիստրացիա է
    const giftKey = giftName.toLowerCase().trim();
    if (giftRegistry[giftKey]) {
      const countryName = giftRegistry[giftKey];
      userTeams[sender] = countryName;
      console.log('🎁✅ Gift-registration: @' + sender + ' → ' + countryName + ' (via ' + giftName + ')');
      broadcast({
        type:        'joinTeam',
        userId:      sender,
        nickname:    data.nickname || sender,
        avatar:      data.profilePictureUrl || '',
        countryName: countryName,   // HTML ակնկալում է countryName
        viaGift:     giftName,
      });
    }

    const payload = {
      type:         'gift',
      giftName:     giftName,
      sender:       sender,
      nickname:     data.nickname || sender,
      senderAvatar: data.profilePictureUrl || '',
      repeatCount:  repeatCount,
      diamondCount: totalDiamonds,
      diamondPer:   diamondPerGift,
    };

    if (teamModeEnabled && userTeams[sender]) {
      console.log('👥 Team mode: @' + sender + ' → ' + userTeams[sender]);
      payload.countryName = userTeams[sender];
    }

    broadcast(payload);
  });

  // ── COMMENT EVENT (team registration) ──
  tiktokConn.on('chat', (data) => {
    const comment = (data.comment || '').trim().toLowerCase();
    const userId = data.uniqueId;
    const avatar = data.profilePictureUrl || '';
    const nickname = data.nickname || userId;

    // Ստուգիր արդյոք հաղորդագրությունը ճշգրիտ հավասար է country անվանը
    // Մեծ/փոքրատառ կապ չունի, առանց որևէ նշանի
    if (comment.length > 0 && comment.length <= 30) {
      const countryName = comment; // ուղղakи անuanu ինqն codё

      // Pahkum ємq always — teamModeEnabled-ics ankax,
      // ays karewor е page refresh-ic hetoin connect linel depqum
      userTeams[userId] = countryName;
      console.log('👥 @' + userId + ' registered → ' + countryName);

      // HTML акnkалum є countryName (oci teamCode)
      broadcast({
        type:        'joinTeam',
        userId:      userId,
        nickname:    nickname,
        avatar:      avatar,
        countryName: countryName,  // Fix: teamCode → countryName
      });
    }
  });

  // ── LIKE EVENT ──
  tiktokConn.on('like', (data) => {
    const sender = data.uniqueId;

    // TikTok like event-ի fields:
    // data.totalLikeCount = sender-ի կուտакային like-ները session-ում (47, 62, 77...)
    // data.likeCount      = room-ի բոլոր viewers-ի combined total — ՉԻ օգտագործել per-sender-ի համար
    // data.likesInBatch   = այս batch-ի like-ները (կարող է undefined լինել)

    let delta = 0;

    if (data.likesInBatch && data.likesInBatch > 0) {
      // Ամենաճшгрит — sender-ի likes-ը այս event-ում
      delta = data.likesInBatch;

    } else if (data.totalLikeCount && data.totalLikeCount > 0) {
      // Sender-ի personal cumulative total (կutak ayin)
      const prev = userLikeCounts[sender];

      if (prev === undefined) {
        // ❗ Առաջին event այս sender-ից — ՊԱՀՊPUM ԵՆՔ baseline, ՉԵՆ ուgharkum
        // Anuznacnum enq totalLikeCount-ը որpeszi հimq reference կetni
        userLikeCounts[sender] = data.totalLikeCount;
        console.log('📌 @' + sender + ' baseline set: ' + data.totalLikeCount + ' (skipping first event)');
        return;
      }

      delta = data.totalLikeCount - prev;

      // Sanity check — delta > 500 means new session / exploit attempt
      if (delta < 0 || delta > 500) {
        console.log('⚠️  @' + sender + ' anomalous delta=' + delta + ' (prev=' + prev + ' new=' + data.totalLikeCount + ') — resetting baseline, skipping');
        userLikeCounts[sender] = data.totalLikeCount;
        return;
      }

      if (delta > 0) userLikeCounts[sender] = data.totalLikeCount;

    } else {
      // totalLikeCount undefined — use fixed batch size (likeCount = room total, useless per-sender)
      delta = 15;
    }

    if (delta <= 0) return;

    const registered = userTeams[sender] ? '✅ ' + userTeams[sender] : '❌ not registered';
    console.log('❤️  @' + sender + ' +' + delta + ' likes | ' + registered +
      ' [totalLikeCount:' + data.totalLikeCount + ' likesInBatch:' + data.likesInBatch + ']');

    const likePayload = {
      type:      'like',
      sender:    sender,
      likeCount: delta,
      nickname:  data.nickname  || sender,
      avatar:    data.profilePictureUrl || data.avatarUrl || '',
    };
    if (userTeams[sender]) {
      likePayload.countryName = userTeams[sender];
    }
    broadcast(likePayload);
  });

  // ── LEAVE EVENT ──
  tiktokConn.on('roomUser', (data) => {
    // roomUser event-ը պարունակում է topViewers list — ստուգենք 누가 떠났는지
    // tiktok-live-connector-ն ուղarকum է 'leave' կամ 'roomUser'
  });

  tiktokConn.on('leave', (data) => {
    const userId = data.uniqueId || data.userId;
    if (!userId) return;
    console.log('🚪 @' + userId + ' left the live');
    broadcast({ type: 'userLeave', userId: userId });
  });

  tiktokConn.on('disconnected', () => {
    console.log('⚠️ Disconnected, retry in 10s...');
    setTimeout(() => connectTikTok(username), 10000);
  });

  tiktokConn.on('error', (err) => {
    console.error('TikTok error:', err);
  });
}
