#!/usr/bin/env node
const assert = require('assert');
const HTTP = require('http');
const HTTP2 = require('http2');
const cluster = require('cluster');
const { performance } = require('perf_hooks');
const uuidv4 = require('uuid/v4');
const bcrypt = require('bcrypt');
const zlib = require('zlib');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const mime = require('mime');
const chokidar = require('chokidar');
const numCPUs = require('os').cpus().length;

const config = {port: 8000, pg: {database: 'qframe', max: 3}, root: 'public', workerCount: numCPUs, saltRounds: 10,
    ...(process.argv[2] && require(process.argv[2]) || JSON.parse(process.env.QFRAME_CONFIG || '{}'))};
global.DB = new Pool(config.pg);

// Migrations
const migrations = config.replaceMigrations || [{
        name: 'Initial tables',
        up:`CREATE EXTENSION IF NOT EXISTS "pgcrypto";
            CREATE TABLE users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                created_time TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_time TIMESTAMP NOT NULL DEFAULT NOW(),
                name TEXT NOT NULL UNIQUE,
                email TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL,
                data JSONB );
            CREATE TABLE sessions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id),
                created_time TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_time TIMESTAMP NOT NULL DEFAULT NOW(),
                csrf TEXT NOT NULL,
                data JSONB );
            CREATE TABLE items (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                created_time TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_time TIMESTAMP NOT NULL DEFAULT NOW(),
                user_id UUID NOT NULL REFERENCES users(id),
                data JSONB );`,
        down: `DROP TABLE users, items, sessions;` }, ...(config.migrations || [])];

// Migration runner
async function migrate(migrations, migrationTarget) {
    var targetMigrationIndex = migrations.findIndex(m => m.name === migrationTarget);
    if (targetMigrationIndex === -1) targetMigrationIndex = migrationTarget || migrations.length-1; 
    const client = await DB.connect();
    try {
        console.log(`Migration target`, [ client.database, targetMigrationIndex, (migrations[targetMigrationIndex] || {name:'EMPTY'}).name ]);
        await client.query('BEGIN');
        await client.query(`CREATE TABLE IF NOT EXISTS migration (db_name TEXT NOT NULL PRIMARY KEY UNIQUE, latest_index INT NOT NULL DEFAULT -1, latest_name TEXT )`);
        await client.query(`CREATE TABLE IF NOT EXISTS migration_log (id SERIAL PRIMARY KEY, db_name TEXT, created_time TIMESTAMP DEFAULT NOW(), name TEXT, direction TEXT, query TEXT, index INT );`);
        var { rows: [migrationStatus] } = await client.query('SELECT * FROM migration WHERE db_name = $1', [client.database]);
        if (!migrationStatus)
            var { rows: [migrationStatus] } = await client.query("INSERT INTO migration (db_name) VALUES ($1) RETURNING *", [client.database]);
        assert(migrationStatus, 'Unable to create migration status database');
        for (let i = migrationStatus.latest_index; i > targetMigrationIndex; i--) {
            await client.query(migrations[i].down);
            await client.query('INSERT INTO migration_log (db_name, name, direction, query, index) VALUES ($1, $2, $3, $4, $5)', [client.database, migrations[i].name, 'down', migrations[i].down, i]);
        }
        for (let i = migrationStatus.latest_index+1; i <= targetMigrationIndex; i++) {
            await client.query(migrations[i].up);
            await client.query('INSERT INTO migration_log (db_name, name, direction, query, index) VALUES ($1, $2, $3, $4, $5)', [client.database, migrations[i].name, 'up', migrations[i].up, i]);
        }
        await client.query('UPDATE migration SET latest_index = $1, latest_name = $2', [targetMigrationIndex, (migrations[targetMigrationIndex] || {}).name]);
        await client.query('COMMIT');
        console.log(`Migration COMMIT`);
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally { client.release(); }
}

// Routing
async function route(routeObj, req, res) {
    const path = req.url.split(/[\/\?]/);   // split on / and ?
    for (let i = 1; i < path.length; i++) { // req.url starts with /, skip the first entry
        routeObj = routeObj[path[i]];
        if (routeObj === undefined) return;
        if (typeof routeObj === 'function') 
            return routeObj(req, res, path.slice(i+1).join("/"));
    }
}

// File serving
global.serveDirectory = function(baseDirectory) {
    const cache = {};
    chokidar.watch('.', {cwd: baseDirectory, ignored: /(^|[\/\\])\../}).on('all', (_, filename) => { try {
        delete cache['/'+filename];
        const buffer = fs.readFileSync(path.join(baseDirectory, filename));
        cache['/'+filename] = { buffer, headers: {'content-type': mime.getType(filename)},
            encodings: buffer.byteLength <= 860 ? {} : {br: zlib.brotliCompress && zlib.brotliCompressSync(buffer, {params: {[zlib.constants.BROTLI_PARAM_QUALITY]: 11}}), gzip: zlib.gzipSync(buffer, {level: 9})} };
    } catch {} });
    return async function(req, res) {
        const reqPath = req.url.split("?")[0];
        const cached = cache[reqPath] || cache[path.join(reqPath, 'index.html')];
        if (!cached) return;
        if (res.targetEncoding && cached.encodings[res.targetEncoding]) res.setHeader('content-encoding', res.targetEncoding);
        res.writeHead(200, cached.headers);
        res.end(cached.encodings[res.targetEncoding] || cached.buffer);
    };
}

// Body JSON parsing
HTTP.ServerResponse.prototype.json = HTTP2.Http2ServerResponse.prototype.json = function(obj, statusCode = 200) {
    var json = Buffer.from(JSON.stringify(obj));
    if (this.targetEncoding && json.byteLength > 0) {
        json = this.targetEncoding === 'br' ? zlib.brotliCompressSync(json, {params: {[zlib.constants.BROTLI_PARAM_QUALITY]: 5}}) : zlib.gzipSync(json, {level: 8});
        this.setHeader('content-encoding', this.targetEncoding);
    }
    this.writeHead(statusCode, {'content-type': 'application/json'});
    this.end(json);
};
global.bodyAsBuffer = (req, maxLen=10e6) => new Promise(function (resolve, reject) {
    var index = 0, buffer = Buffer.allocUnsafe(4096);
    req.on('data', function(b) {
        index += b.byteLength;
        if (index > maxLen) reject(Error('413: Body too large'));
        if (index > buffer.byteLength) {
            buffer = Buffer.allocUnsafe(1 << Math.ceil(Math.log2(index)));
            buffer.set(buffer);
        } // this is ~O(N) in length of request
        buffer.set(b, index - b.byteLength); });
    req.on('end', function() { resolve(buffer.slice(0, index)) });
    req.on('error', reject); });
global.bodyAsString = async (req, maxLen=1e6) => (await bodyAsBuffer(req, maxLen)).toString(); 
global.bodyAsJson = async (req, maxLen=1e6) => JSON.parse(await bodyAsBuffer(req, maxLen));

// Authorization & CSRF guards
global.guardPostWithSession = async function(req) {
    assert(req.method === 'POST', "405: Only POST accepted");
    const session = await sessionGet(req);
    assert(session, '401: User session invalid, please re-authenticate');
    assert(req.headers.csrf === session.csrf, '401: Invalid CSRF token, please re-authenticate');
    return session;
}
global.guardGetWithUser = async function(req) {
    const session = await sessionGet(req);
    assert(session, '401: User session invalid, please re-authenticate');
    return session.user_id;
}
global.guardPostWithUserAndJson = async function(req) {
    const sessionP = guardPostWithSession(req); // Run these two concurrently
    const jsonP = bodyAsJson(req);
    return {user: (await sessionP).user_id, json: await jsonP};
}

// Session management
const sessionCreate = async (userId) => 
    (await DB.query('INSERT INTO sessions (user_id, csrf) VALUES ($1, $2) RETURNING *', [userId, uuidv4()])).rows[0];
const sessionGet = async (req) =>
    (await DB.query('SELECT * FROM sessions WHERE id = $1', [req.headers['session']])).rows[0];
const sessionDelete = async (id, userId) =>
    (await DB.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [id, userId])).rowCount > 0;
const sessionDeleteAll = async (userId) =>
    (await DB.query('DELETE FROM sessions WHERE user_id = $1', [userId])).rowCount;
const sessionList = async (userId) =>
    (await DB.query(`SELECT id AS session, csrf, created_time, updated_time, data FROM sessions WHERE user_id = $1 ORDER BY created_time ASC`, [userId])).rows;

// User accounts
const user = {
    create: async function(req, res) {
        assert(req.method === 'POST', "405: Only POST accepted");
        const { email, password, name } = await bodyAsJson(req);
        assert(email, "400: No email provided");
        assert(password, "400: No password provided");
        assert(name, "400: No name provided");
        const passwordHash = await bcrypt.hash(password, config.saltRounds);
        const { rows: [user] } = await DB.query('INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id', [email, passwordHash, name]);
        assert(user, '500: User database insert failed');
        const session = await sessionCreate(user.id);        
        res.json({session: session.id, csrf: session.csrf});
    },
    authenticate: async function(req, res) {
        assert(req.method === 'POST', "405: Only POST accepted");
        const { email, password } = await bodyAsJson(req);
        assert(email, "400: No email provided");
        assert(password, "400: No password provided");
        const { rows: [user] } = await DB.query('SELECT * FROM users WHERE email = $1', [email]);
        assert(user, "401: Email or password is wrong");
        const passwordMatch = await bcrypt.compare(password, user.password);
        assert(passwordMatch, "401: Email or password is wrong");
        const session = await sessionCreate(user.id);        
        res.json({session: session.id, csrf: session.csrf});
    },
    sessions: async function(req, res) {
        const user = await guardGetWithUser(req);
        res.json(await sessionList(user));
    },
    logout: async function(req, res) {
        const session = await guardPostWithSession(req);
        const json = JSON.parse((await bodyAsString(req)) || '{}');
        const sessionId = json.session || session.id;
        assert(await sessionDelete(sessionId, session.user_id), '404: Session not found');
        res.json({deleted: 1});
    },
    logoutAll: async function(req, res) {
        const session = await guardPostWithSession(req);
        res.json({deleted: await sessionDeleteAll(session.user_id)});
    },
    view: async function(req, res) {
        const user = await guardGetWithUser(req);
        const { rows } = await DB.query('SELECT email, created_time, updated_time, data FROM users WHERE id = $1', [user]);
        assert(rows[0], '404: User not found');
        res.json(rows[0]);
    },
    edit: {
        data: async function(req, res) {
            const {user, json} = await guardPostWithUserAndJson(req);
            const { rows } = await DB.query('UPDATE users SET data = $1 WHERE id = $2 RETURNING email, data', [json, user]);
            assert(rows[0], '404: User not found');
            res.json(rows[0]);
        },
        email: async function(req, res) {
            const {user, json} = await guardPostWithUserAndJson(req);
            assert(json.email, "400: No new email provided");
            const { rows } = await DB.query('UPDATE users SET email = $1 WHERE id = $2 RETURNING email', [json.email, user]);
            assert(rows[0], '404: User not found');
            res.json(rows[0]);
        },
        password: async function(req, res) {
            const {user, json} = await guardPostWithUserAndJson(req);
            assert(json.password, "400: No new password provided");
            const passwordHash = await bcrypt.hash(json.password, saltRounds);
            const { rows } = await DB.query('UPDATE users SET password = $1 WHERE id = $2 RETURNING email', [passwordHash, user]);
            assert(rows[0], '404: User not found');
            res.json(rows[0]);
        }
    }
};

// Items
const items = {
    create: async function(req, res) {
        const {user, json} = await guardPostWithUserAndJson(req);
        const { rows } = await DB.query('INSERT INTO items (data, user_id) VALUES ($1, $2) RETURNING id, data, created_time, updated_time', [json, user]);
        assert(rows[0], '500: Item creation failed');
        res.json(rows[0])
    },
    list: async function(req, res) {
        const user = await guardGetWithUser(req);
        const { rows } = await DB.query(`SELECT c.id, c.data, c.created_time, c.updated_time, u.name AS username 
            FROM items c, users u  WHERE c.user_id = $1 AND u.id = c.user_id ORDER BY created_time ASC`, [user]);
        res.json(rows);
    },
    view: async function(req, res, name) {
        assert(name, "404: No id provided");
        const { rows } = await DB.query(`SELECT c.id, c.data, c.created_time, c.updated_time, u.name AS username
            FROM items c, users u WHERE c.id = $1 AND u.id = c.user_id`, [name]);
        assert(rows[0], '404: Item not found');
        res.json(rows[0]);
    },
    edit: async function(req, res) {
        const {user, json} = await guardPostWithUserAndJson(req);
        assert(json.id, "400: No id provided");
        assert(json.data !== undefined, "400: No data provided");
        const { rows } = await DB.query('UPDATE items SET data = $1 WHERE id = $2 AND user_id = $3 RETURNING id, data, created_time, updated_time', [json.data, json.id, user]);
        assert(rows[0], '404: Item not found');
        res.json(rows[0]);
    },
    delete: async function(req, res) {
        const {user, json} = await guardPostWithUserAndJson(req);
        assert(json.id, "400: No id provided");
        const { rowCount } = await DB.query('DELETE FROM items WHERE id = $1 AND user_id = $2', [json.id, user]);
        assert(rowCount > 0, '404: Item not found');
        res.json({deleted: rowCount});
    }
};

// Cluster
if (cluster.isMaster) {
    migrate(migrations, config.migrationTarget).then(() => {
        for (let i = 0; i < config.workerCount; i++) cluster.fork(); });
} else {
    // Routes
    const routes = config.routes || { _: {items, user, ...config.api} };
    const fallbackRoute = config.fallbackRoute || serveDirectory(config.root);

    // HTTP Server
    const encRe = zlib.brotliCompress ? /\b(br|gzip)\b/g : /\bgzip\b/g; 
    (config.cert || config.pfx ? HTTP2.createSecureServer : HTTP.createServer)(config, async function(req, res) {
        const t0 = performance.now();
        try {
            res.targetEncoding = ((req.headers['accept-encoding'] || '').match(encRe) || []).sort()[0];
            await route(routes, req, res);
            if (!res.finished) await fallbackRoute(req, res);
            assert(res.finished, "404: Route not found");
        } catch({message}) {
            const status = parseInt(message.slice(0,3)) || 500;
            config.logError && config.logError(req, status, message, performance.now() - t0);
            res.json({status, message}, status);
        }
        config.logAccess && config.logAccess(req, res.statusCode, performance.now() - t0);
    }).listen(config.port, () => console.log(`[${process.pid}] Server running on ${config.port}`));
} // THIS IS SPARTA