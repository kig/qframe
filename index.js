const assert = require('assert');
const HTTP = require('http');
const cluster = require('cluster');
const uuidv4 = require('uuid/v4');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const fs = require('fs');
const stream = require('stream');
const path = require('path');
const util = require('util');
const mimedb = require('mime-db');
const numCPUs = require('os').cpus().length;
const [open, close, fstat] = [fs.open, fs.close, fs.fstat].map(util.promisify);
const pipeline = util.promisify(stream.pipeline);

const HTTP_SERVER_PORT = 8000;
const saltRounds = 10;
const DB = new Pool({database: 'qframe'});

// Migrations
const Migrations = [{
        name: 'Initial tables',
        up:`CREATE EXTENSION IF NOT EXISTS "pgcrypto";
            CREATE TABLE users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                created_time TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_time TIMESTAMP NOT NULL DEFAULT NOW(),
                name TEXT NOT NULL UNIQUE,
                email TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL,
                data JSONB
            );
            CREATE TABLE sessions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id),
                created_time TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_time TIMESTAMP NOT NULL DEFAULT NOW(),
                csrf TEXT NOT NULL,
                data JSONB
            );
            CREATE TABLE items (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                created_time TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_time TIMESTAMP NOT NULL DEFAULT NOW(),
                user_id UUID NOT NULL REFERENCES users(id),
                data JSONB
            );`,
        down: `DROP TABLE users, items, sessions;` }];

// Migration runner
async function migrate(migrations, targetMigrationIndex=migrations.length-1) {
    const client = await DB.connect();
    try {
        await client.query('BEGIN');
        await client.query(`CREATE TABLE IF NOT EXISTS migration (
                db_name TEXT NOT NULL PRIMARY KEY UNIQUE,
                latest_index INT NOT NULL DEFAULT -1,
                latest_name TEXT )`);
        var { rows: [migrationStatus] } = await client.query('SELECT * FROM migration WHERE db_name = $1', [client.database]);
        if (!migrationStatus) {
            var { rows: [migrationStatus] } = await client.query("INSERT INTO migration (db_name) VALUES ($1) RETURNING *", [client.database]);
        }
        assert(migrationStatus, 'Unable to create migration status database');
        for (let i = migrationStatus.latest_index; i > targetMigrationIndex; i--)
            await client.query(migrations[i].down);
        for (let i = migrationStatus.latest_index+1; i <= targetMigrationIndex; i++)
            await client.query(migrations[i].up);
        await client.query('UPDATE migration SET latest_index = $1, latest_name = $2', [targetMigrationIndex, (migrations[targetMigrationIndex] || {}).name]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Routing
async function route(routeObj, req, res) {
    const path = req.url.split("/").slice(1);
    for (var i = 0; i < path.length; i++) {
        const currentDir = path[i];
        const nextRouteObj = routeObj[currentDir];
        if (!nextRouteObj) {
            break;
        } else if (typeof nextRouteObj === 'function') {
            req.name = path.slice(i+1).join("/");
            return nextRouteObj(req, res);
        }
        routeObj = nextRouteObj;
    }
}

// File serving
const extMimeTypes = {};
for (let mime in mimedb) {
    (mimedb[mime].extensions || []).forEach(ext => extMimeTypes[ext] = mime);
}
async function serveDirectory(baseDirectory, req, res) {
    const reqPath = req.url.split("?")[0];
    var fsPath = path.join(baseDirectory, path.normalize('/' + reqPath));
    assert(fsPath.startsWith(path.normalize(baseDirectory + '/')), '403: Permission denied');
    const isDir = /\/$/.test(reqPath);
    try {
        var fd = isDir ? null : await open(fsPath, 'r');
        if (isDir || (await fstat(fd)).isDirectory()) {
            if (fd !== null) close(fd); // do this concurrently
            fsPath = path.join(fsPath, 'index.html');
            fd = await open(fsPath, 'r');
        }
    } catch(err) {
        assert(!err.message.startsWith("ENOENT:"), "404: File not found");
        assert(!err.message.startsWith("EACCES:"), "403: Permission denied");
        throw err;
    }
    const mimetype = extMimeTypes[path.extname(fsPath).slice(1)] || 'application/octet-stream';
    const fileStream = fs.createReadStream(fsPath, {fd});
    res.writeHead(200, {'Content-Type': mimetype});
    await pipeline(fileStream, res);
}

// Body JSON parsing
HTTP.ServerResponse.prototype.json = function(obj, statusCode = 200) {
    this.writeHead(statusCode, {'Content-Type': 'application/json'});
    this.end(JSON.stringify(obj));
};
const bodyAsBuffer = (req) => new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', b => chunks.push(b));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
});
const bodyAsString = async req => (await bodyAsBuffer(req)).toString(); 
const bodyAsJson = async req => JSON.parse(await bodyAsString(req));

// Authorization & CSRF guards
async function guardPostWithSession(req) {
    assert(req.method === 'POST', "405: Only POST accepted");
    const session = await sessionGet(req);
    assert(session, '401: User session invalid, please re-authenticate');
    assert(req.headers.csrf === session.csrf, '401: Invalid CSRF token, please re-authenticate');
    return session;
}
async function guardGetWithUser(req) {
    const session = await sessionGet(req);
    assert(session, '401: User session invalid, please re-authenticate');
    return session.user_id;
}
async function guardPostWithUserAndJson(req) {
    const sessionP = guardPostWithSession(req); // Run these two concurrently
    const jsonP = bodyAsJson(req);
    return {user: (await sessionP).user_id, json: await jsonP}; 
}

// Session management
const sessionCreate = async (id) => 
    (await DB.query('INSERT INTO sessions (user_id, csrf) VALUES ($1, $2) RETURNING *', [id, uuidv4()])).rows[0];
const sessionGet = async (req) =>
    (await DB.query('SELECT * FROM sessions WHERE id = $1', [req.headers['session']])).rows[0];
const sessionDelete = async (id, user_idId) =>
    (await DB.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [id, user_idId])).rowCount > 0;
const sessionDeleteAll = async (user_idId) =>
    (await DB.query('DELETE FROM sessions WHERE user_id = $1', [user_idId])).rowCount;
const sessionList = async (user_idId) =>
    (await DB.query(`SELECT id AS session, csrf, created_time, updated_time, data FROM sessions WHERE user_id = $1 ORDER BY created_time ASC`, [user_idId])).rows;

// User accounts
const User = {
    create: async function(req, res) {
        assert(req.method === 'POST', "405: Only POST accepted");
        const { email, password, name } = await bodyAsJson(req);
        assert(email, "400: No email provided");
        assert(password, "400: No password provided");
        assert(name, "400: No name provided");
        const passwordHash = await bcrypt.hash(password, saltRounds);
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
const Items = {
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
    view: async function(req, res) {
        assert(req.name, "404: No id provided");
        const { rows } = await DB.query(`SELECT c.id, c.data, c.created_time, c.updated_time, u.name AS username
            FROM items c, users u WHERE c.id = $1 AND u.id = c.user_id`, [req.name]);
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

// Routes
const Routes = { items: Items, user: User };

// HTTP Server
const server = new HTTP.createServer(async function(req, res) {
    try {
        await route(Routes, req, res);
        if (!res.finished) await serveDirectory('public/', req, res);
        assert(res.finished, "404: Route not found");
    } catch({message}) {
        const statusCodeMatch = message.match(/^(\d{3})[^\d]/);
        const status = statusCodeMatch ? parseInt(statusCodeMatch[1]) : 500;
        res.json({status, message}, status);
    }
});

// Cluster
if (cluster.isMaster) {
    for (let i = 0; i < numCPUs; i++) cluster.fork();
    cluster.on('exit', (worker, code, signal) => cluster.fork());
    DB.connect().then(() => migrate(Migrations));
} else {
    DB.connect().then(() => server.listen(HTTP_SERVER_PORT, () => console.log(`[${process.pid}] Server running on ${HTTP_SERVER_PORT}`)));
} // THIS IS SPARTA