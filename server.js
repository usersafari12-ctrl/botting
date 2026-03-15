'use strict';

const WebSocket    = require('ws');
const express      = require('express');
const admin        = require('firebase-admin');

// ── Firebase Admin init ───────────────────────────────────────────────────────
// Set FIREBASE_SERVICE_ACCOUNT env var on Render to the full JSON of your
// service account key (Settings → Environment → Add env var).
// Download it from Firebase Console → Project Settings → Service Accounts → Generate new private key
let firebaseReady = false;
try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (sa.project_id) {
        admin.initializeApp({
            credential: admin.credential.cert(sa),
        });
        firebaseReady = true;
        console.log('[Firebase Admin] initialized for project:', sa.project_id);
    } else {
        console.warn('[Firebase Admin] FIREBASE_SERVICE_ACCOUNT not set — user management disabled');
    }
} catch(e) {
    console.error('[Firebase Admin] init error:', e.message);
}

const db = () => firebaseReady ? admin.firestore() : null;
const au = () => firebaseReady ? admin.auth()      : null;

const app  = express();

// ── CORS — allow requests from any origin (browser portal, file://, etc.) ───
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.json());

// ── Serve portal.html at / ───────────────────────────────────────────────────
app.use(express.static(__dirname));

// ── Mode configs ─────────────────────────────────────────────────────────────
const MODES = {
    lag: {
        label:       'BSG CTG LAG',
        handshake:   Buffer.from([0x03, 0x87, 0x05, 0x02, 0x06]),
        heartbeatMs: 2500,
        tickMs:      50,
        jumpEvery:   20,   // ticks between jumps  (~1 s at 20 ticks/s)
        slot:        1,    // slot index (slot 2 in-game)
    },
    pillar: {
        label:       'PILLAR BOT',
        handshake:   Buffer.from([0x03, 0x87, 0x03, 0x02, 0x05]),
        heartbeatMs: 50,
        tickMs:      50,
        jumpEvery:   60,   // ticks between jumps  (~3 s at 20 ticks/s)
        placeAfter:  8,    // ticks after jump to place block (near peak)
        slot:        3,    // slot index (slot 4 in-game)
    },
};

// ── State ─────────────────────────────────────────────────────────────────────
const bots = {};          // id → bot object
let   nextId = 1;

// ── Packet builder ────────────────────────────────────────────────────────────
// Mirrors the browser script's buildPacket() exactly.
function buildPacket(bot, opts) {
    opts = opts || {};
    const isSlot = (opts.slot !== undefined);
    const buf = Buffer.alloc(isSlot ? 22 : 21);

    // Sequence — 5 bytes big-endian
    buf[0] = (bot.seq / 0x100000000) >>> 0 & 0xFF;
    buf[1] = (bot.seq >>> 24) & 0xFF;
    buf[2] = (bot.seq >>> 16) & 0xFF;
    buf[3] = (bot.seq >>>  8) & 0xFF;
    buf[4] = (bot.seq >>>  0) & 0xFF;

    buf[5] = 0; buf[6] = 0; buf[7] = 0; buf[8] = 0;

    if (bot.mode === 'pillar') {
        // Locked straight-down pitch: bf c9 0f db = -PI/2
        buf[9] = 0xbf; buf[10] = 0xc9; buf[11] = 0x0f; buf[12] = 0xdb;
    } else {
        // Drifting pitch (lag mode)
        buf.writeFloatBE(bot.pitch, 9);
    }

    buf.writeFloatBE(bot.yaw, 13);

    buf[17] = 0x7f;
    buf[18] = 0x7f;

    if (isSlot) {
        buf[19] = 0x01;
        buf[20] = 0x00;
        buf[21] = opts.slot & 0xFF;
    } else if (opts.jump) {
        buf[19] = 0x02;
        buf[20] = (bot.mode === 'pillar') ? 0x03 : 0x00;
    } else if (opts.place) {
        buf[19] = 0x00;
        buf[20] = 0x00;
    } else if (opts.click) {
        buf[19] = 0x00;
        buf[20] = 0x00;
    } else {
        buf[19] = 0x00;
        buf[20] = 0x03;
    }

    bot.seq++;
    return buf;
}

// ── Create & run one bot ──────────────────────────────────────────────────────
function createBot(id, url, mode, lifetimeSecs) {
    const cfg = MODES[mode];

    const bot = {
        id,
        url,
        mode,
        alive:        false,
        seq:          0,
        yaw:          Math.random() * Math.PI * 2,
        pitch:        (Math.random() - 0.5) * 1.0,
        timerStarted: false,
        heartbeatInterval: null,
        tickInterval:      null,
        killTimer:         null,
        ws:           null,
        startedAt:    new Date().toISOString(),
        status:       'connecting',
        cycleOnDeath: false,   // set by deploy when cycle is requested
        cycleUrl:     url,
        cycleMode:    mode,
        cycleLifetime: lifetimeSecs,
    };

    let tickCycle = 0;

    function tickLag() {
        if (!bot.ws || bot.ws.readyState !== WebSocket.OPEN) return;
        bot.yaw   += (Math.random() - 0.5) * 0.15;
        bot.pitch += (Math.random() - 0.5) * 0.1;
        if (bot.pitch >  1.5) bot.pitch =  1.5;
        if (bot.pitch < -1.5) bot.pitch = -1.5;
        tickCycle++;
        const phase = tickCycle % cfg.jumpEvery;
        if (phase === 1) {
            bot.ws.send(buildPacket(bot, { jump: true }));
        } else {
            bot.ws.send(buildPacket(bot, { click: true }));
        }
    }

    function tickPillar() {
        if (!bot.ws || bot.ws.readyState !== WebSocket.OPEN) return;
        bot.yaw += 0.008;
        if (bot.yaw > Math.PI * 2) bot.yaw -= Math.PI * 2;
        tickCycle++;
        const phase = tickCycle % cfg.jumpEvery;
        if (phase === 1) {
            bot.ws.send(buildPacket(bot, { jump: true }));
        } else if (phase === cfg.placeAfter) {
            bot.ws.send(buildPacket(bot, { place: true }));
        } else {
            bot.ws.send(buildPacket(bot));
        }
    }

    const tick = (mode === 'pillar') ? tickPillar : tickLag;

    // ── KEY: set Origin header so the game server accepts the connection ──────
    bot.ws = new WebSocket(url, {
        headers: {
            'Origin':     'https://voxiom.io',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                          'Chrome/124.0.0.0 Safari/537.36',
        },
        rejectUnauthorized: false,
    });
    bot.ws.binaryType = 'nodebuffer';

    bot.ws.on('open', () => {
        bot.alive  = true;
        bot.seq    = 0;
        bot.status = 'connected';
        bot.ws.send(cfg.handshake);
        console.log(`[#${id}] connected [${cfg.label}]`);

        bot.heartbeatInterval = setInterval(() => {
            if (bot.ws && bot.ws.readyState === WebSocket.OPEN)
                bot.ws.send(Buffer.from([0x06]));
        }, cfg.heartbeatMs);

        // Start ticking immediately — no delay
        bot.tickInterval = setInterval(tick, cfg.tickMs);
    });

    bot.ws.on('message', (data) => {
        if (!Buffer.isBuffer(data)) return;
        if (bot.timerStarted) return;
        bot.timerStarted = true;
        bot.status       = 'in-game';

        // Fully joined — switch to the correct slot
        bot.ws.send(buildPacket(bot, { slot: cfg.slot }));
        console.log(`[#${id}] joined game — ${lifetimeSecs}s lifetime`);

        // Auto-kill after lifetime expires
        bot.killTimer = setTimeout(() => {
            console.log(`[#${id}] lifetime expired, disconnecting`);
            destroyBot(id);
        }, lifetimeSecs * 1000);
    });

    bot.ws.on('error', (err) => {
        console.error(`[#${id}] ws error: ${err.message}`);
        bot.status = 'error';
    });

    bot.ws.on('close', (code) => {
        bot.alive  = false;
        bot.status = 'dead';
        console.log(`[#${id}] closed (code ${code})`);
        clearInterval(bot.heartbeatInterval);
        clearInterval(bot.tickInterval);

        // ── Cycle: spawn a replacement immediately on death ───────
        if (bot.cycleOnDeath) {
            console.log(`[#${id}] cycling — spawning replacement`);
            setTimeout(() => {
                const newId = nextId++;
                bots[newId] = createBot(newId, bot.cycleUrl, bot.cycleMode, bot.cycleLifetime);
                bots[newId].cycleOnDeath  = true;
                bots[newId].cycleUrl      = bot.cycleUrl;
                bots[newId].cycleMode     = bot.cycleMode;
                bots[newId].cycleLifetime = bot.cycleLifetime;
            }, 500);
        }

        // Remove from map after a short delay so /status can still show 'dead'
        setTimeout(() => { delete bots[id]; }, 5000);
    });

    bot.destroy = function () {
        clearInterval(bot.heartbeatInterval);
        clearInterval(bot.tickInterval);
        clearTimeout(bot.killTimer);
        bot.cycleOnDeath = false;  // don't cycle if manually killed
        if (bot.ws) bot.ws.close();
    };

    return bot;
}

// ── Destroy a bot ─────────────────────────────────────────────────────────────
function destroyBot(id) {
    const bot = bots[id];
    if (!bot) return false;
    bot.destroy();
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /deploy
 * Body (JSON):
 * {
 *   "url":      "wss://game-server-XXXXX.voxiom.io:443",   // required
 *   "count":    5,                                          // optional, default 1, max 50
 *   "mode":     "lag",                                      // optional: "lag" | "pillar"
 *   "lifetime": 35                                          // optional, seconds, default 35
 * }
 */
app.post('/deploy', (req, res) => {
    const { url, count = 1, mode = 'lag', lifetime = 35, cycle = false } = req.body;

    if (!url || !url.startsWith('wss://')) {
        return res.status(400).json({ error: 'url must start with wss://' });
    }
    if (!MODES[mode]) {
        return res.status(400).json({ error: 'mode must be "lag" or "pillar"' });
    }
    const n         = Math.min(50, Math.max(1, parseInt(count)   || 1));
    const lifetime_ = Math.min(300, Math.max(1, parseInt(lifetime) || 35));

    for (let i = 0; i < n; i++) {
        setTimeout(() => {
            const id  = nextId++;
            const bot = createBot(id, url, mode, lifetime_);
            bot.cycleOnDeath  = !!cycle;
            bot.cycleUrl      = url;
            bot.cycleMode     = mode;
            bot.cycleLifetime = lifetime_;
            bots[id] = bot;
        }, i * 250);
    }

    return res.json({
        ok:       true,
        deploying: n,
        mode,
        lifetime: lifetime_,
        cycle:    !!cycle,
    });
});

/**
 * GET /status
 * Returns all bots currently tracked.
 */
app.get('/status', (req, res) => {
    const list = Object.values(bots).map(b => ({
        id:        b.id,
        mode:      b.mode,
        status:    b.status,
        alive:     b.alive,
        startedAt: b.startedAt,
    }));

    res.json({
        total:   list.length,
        active:  list.filter(b => b.alive).length,
        dead:    list.filter(b => !b.alive).length,
        bots:    list,
    });
});

/**
 * DELETE /kill/:id
 * Kill a single bot by ID.
 */
app.delete('/kill/:id', (req, res) => {
    const id = parseInt(req.params.id);
    if (!bots[id]) return res.status(404).json({ error: `Bot #${id} not found` });
    destroyBot(id);
    res.json({ ok: true, killed: id });
});

/**
 * DELETE /kill-all
 * Kill every active bot.
 */
app.delete('/kill-all', (req, res) => {
    const ids = Object.keys(bots).map(Number);
    ids.forEach(destroyBot);
    res.json({ ok: true, killed: ids });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware helpers
// ─────────────────────────────────────────────────────────────────────────────

// Verify Firebase ID token from Authorization: Bearer <token> header
async function requireAuth(req, res, next) {
    if (!firebaseReady) return res.status(503).json({ error: 'Firebase not configured' });
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing auth token' });
    try {
        req.user = await au().verifyIdToken(token);
        next();
    } catch(e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

// Require admin custom claim
async function requireAdmin(req, res, next) {
    await requireAuth(req, res, async () => {
        if (!req.user.admin) return res.status(403).json({ error: 'Admin only' });
        next();
    });
}

// Get real client IP (works behind Render's proxy)
function clientIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.socket.remoteAddress
        || 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// User IP lock endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /auth/verify-ip
 * Called by portal on every login. Checks the user's IP against Firestore.
 * Body: { uid }   Header: Authorization: Bearer <idToken>
 */
app.post('/auth/verify-ip', requireAuth, async (req, res) => {
    const uid = req.user.uid;
    const ip  = clientIp(req);

    try {
        const doc = await db().collection('users').doc(uid).get();
        if (!doc.exists) {
            return res.status(403).json({ ok: false, error: 'User not whitelisted. Contact admin.' });
        }
        const data = doc.data();

        // Admin accounts are never IP-locked
        if (data.admin) return res.json({ ok: true });

        const allowedIp = data.allowedIp || null;
        if (!allowedIp) {
            // First login — record their IP automatically
            await db().collection('users').doc(uid).update({ allowedIp: ip, lastSeen: new Date().toISOString() });
            return res.json({ ok: true, ip });
        }

        if (allowedIp !== ip) {
            return res.status(403).json({ ok: false, error: `IP not allowed. Expected ${allowedIp}, got ${ip}` });
        }

        await db().collection('users').doc(uid).update({ lastSeen: new Date().toISOString() });
        res.json({ ok: true, ip });
    } catch(e) {
        console.error('[verify-ip]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin — user management endpoints  (all require admin claim)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /admin/users
 * Returns all users from Firebase Auth + their Firestore metadata.
 */
app.get('/admin/users', requireAdmin, async (req, res) => {
    try {
        const listResult = await au().listUsers(1000);
        const snapshot   = await db().collection('users').get();
        const meta = {};
        snapshot.forEach(d => { meta[d.id] = d.data(); });

        const users = listResult.users.map(u => ({
            uid:         u.uid,
            email:       u.email || '',
            displayName: u.displayName || '',
            disabled:    u.disabled,
            created:     u.metadata.creationTime,
            lastSignIn:  u.metadata.lastSignInTime,
            allowedIp:   meta[u.uid]?.allowedIp  || null,
            whitelisted: !!meta[u.uid],
            admin:       !!(u.customClaims?.admin || meta[u.uid]?.admin),
            lastSeen:    meta[u.uid]?.lastSeen    || null,
        }));

        res.json({ ok: true, users });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /admin/whitelist
 * Whitelist a new user by email + set their allowed IP.
 * Body: { email, allowedIp }
 */
app.post('/admin/whitelist', requireAdmin, async (req, res) => {
    const { email, allowedIp } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    try {
        let userRecord;
        try {
            userRecord = await au().getUserByEmail(email);
        } catch(e) {
            return res.status(404).json({ error: `No Firebase account found for ${email}. They must sign in once first.` });
        }

        await db().collection('users').doc(userRecord.uid).set({
            email,
            allowedIp: allowedIp || null,
            whitelisted: true,
            addedAt: new Date().toISOString(),
        }, { merge: true });

        res.json({ ok: true, uid: userRecord.uid, email, allowedIp });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /admin/revoke/:uid
 * Force-revoke all sessions for a user (signs them out everywhere).
 */
app.post('/admin/revoke/:uid', requireAdmin, async (req, res) => {
    try {
        await au().revokeRefreshTokens(req.params.uid);
        await db().collection('users').doc(req.params.uid).update({
            revokedAt: new Date().toISOString()
        });
        res.json({ ok: true, revoked: req.params.uid });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * DELETE /admin/user/:uid
 * Delete a user from Firebase Auth + remove their Firestore record.
 */
app.delete('/admin/user/:uid', requireAdmin, async (req, res) => {
    try {
        await au().deleteUser(req.params.uid);
        await db().collection('users').doc(req.params.uid).delete();
        res.json({ ok: true, deleted: req.params.uid });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * PATCH /admin/user/:uid
 * Update a user's allowed IP or admin status.
 * Body: { allowedIp?, admin? }
 */
app.patch('/admin/user/:uid', requireAdmin, async (req, res) => {
    const { allowedIp, admin: isAdmin } = req.body;
    try {
        const updates = {};
        if (allowedIp  !== undefined) updates.allowedIp = allowedIp;
        if (isAdmin    !== undefined) {
            updates.admin = isAdmin;
            await au().setCustomUserClaims(req.params.uid, { admin: isAdmin });
        }
        await db().collection('users').doc(req.params.uid).update(updates);
        res.json({ ok: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /admin/my-ip
 * Returns the admin's current IP — useful when whitelisting users.
 */
app.get('/admin/my-ip', requireAdmin, (req, res) => {
    res.json({ ip: clientIp(req) });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Voxiom Bot Server running on port ${PORT}`);
    console.log('Endpoints:');
    console.log('  POST   /deploy');
    console.log('  GET    /status');
    console.log('  DELETE /kill/:id');
    console.log('  DELETE /kill-all');
});
