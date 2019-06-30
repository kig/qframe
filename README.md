# Qframe 0.9.3

Front-end friendly JSON API server in 300 lines of code.
Ideal for use with something like `create-react-app`.

Uses PostgreSQL as the database.


## Features

 * User accounts using email & password for auth
 * User sessions that persist over server restarts
 * User.items from item table with CRUD
 * JSON `data` field for storing user, item and session details
 * Routing
 * DB migrations
 * Static file serving from cached memory buffers with `chokidar` change watcher
 * Brotli and gzip compression, cached for static files.
 * Multi-process cluster server (not HA though)
 * Fast server dev iteration using nodemon to restart server on changes
 * Full SQL support from `node-postgres`
 * Support for serving over HTTP, HTTPS & HTTP/2
 * Config from file or env var

Performance testing on a 4-core MBP, using `bombardier -n 1000000 -c 300 http://localhost:8000/`

 * Static file over HTTP, ~80 kreqs/s 
 * `/_/items/view` DB read over HTTP/HTTPS, ~12 kreqs/s
 * Around 60k static file HTTPS reqs per second

## Usage

Start the default API server. The server runs on port 8000, connects to the PostgreSQL database `qframe`, and serves files from `./public`.

```bash
$ createdb qframe
$ npx qframe
# For faster startup
$ yarn global add qframe
```

Open http://localhost:8000 in your browser and try out the built-in API in the console

```javascript
var headers = {};
var get = async(path) => (await fetch(path, {headers})).json();
var post = async(path, body) => (await fetch(path, {method:'POST', headers, body: JSON.stringify(body)})).json();
var user = await post('/_/user/create', {email:'foo@bar', name: 'foo', password: 'bar'});
headers = await post('/_/user/authenticate', {email: 'foo@bar', password: 'bar'});
var userData = await post('/_/user/edit/data', {avatar: "pirate", favouriteQuote: "Pinata Pirata!"});
var {id} = await post('/_/items/create', {name: "My wonderful item", wonderfulness: 9999});
var item = await get(`/_/items/view/${id}`);
await post('/_/items/edit', {id, data: {name: "My wonderful item", wonderfulness: 10000}})
var items = await get(`/_/items/list`);
console.log(user, headers, userData, item, items);
```

Or you can jump straight in and make your own custom server.

```bash
$ git clone https://github.com/kig/qframe
$ cd qframe
$ createdb qframe
$ yarn
$ yarn nodemon .
# Edit index.js to customize your server
```

But maybe you can do your thing with the handy config system!

```bash
$ createdb my_db
$ QFRAME_CONFIG='{"port": 8888, "pg":{"database": "my_db"}, "root": "/var/www/html"}' npx qframe 
# Or use a config file
$ echo '{"port": 8888, "pg":{"database": "my_db"}, "root": "/var/www/html"}' > qframe.json
$ npx qframe ./qframe.json # Note that you need the ./ here, the file is loaded using require()
```

## `mictest.js` example config

The config file is loaded using `require()`, so you can go wild. Here's an example of setting up some custom API endpoints on a localhost HTTP/2 server.

```javascript
const fs = require('fs');
const util = require('util');
const pipeline = util.promisify(require('stream').pipeline);

module.exports = {
    // Web server port.
    port: 8000,

    // Override cluster worker count.
    // The default is the number of logical CPUs (i.e. hyperthreads).
    // workerCount: 1,

    // Database Pool config.
    // See node-postgres docs for details.
    pg: {database: 'mictest'},

    // Password salting rounds, see bcrypt docs.
    // saltRounds: 10,

    // The config object is passed straight to
    // HTTP.createServer if there's no cert or pfx, or
    // HTTP2.createSecureServer if cert or pfx is set.
    // See the node HTTP/HTTP2 docs for details.
    allowHTTP1: true,
    cert: fs.readFileSync("localhost-cert.pem"),
    key: fs.readFileSync("localhost-privkey.pem"),
    // pfx: fs.readFileSync("localhost.pfx"),
    // passphrase: "blabla",

    // Called at the end of a request
    logAccess: function(req, status, elapsed) {
        console.log([status, req.url, elapsed]);
    },

    // Called when a request errors out
    logError: function(req, status, message) {
        console.error([status, req.url, message]);
    },

    // root serves static files document root.
    // All the files under this directory are cached to memory,
    // once for each cluster worker.
    // So, um, don't put large files here. 
    // root: '/var/www/html',

    // api adds routes under /_/
    api: {
        hello: async (req, res) => res.json({hello: "world"}),
        echo: async (req, res) => res.end(await global.bodyAsBuffer(req)),
        save: async (req, res) => {
            await pipeline(req, fs.createWriteStream('saved_file.dat'));
            res.end("Your file is safe with me, for now.");
        },
        savedFile: async (req, res) => pipeline(fs.createReadStream('saved_file.dat'), res),
        migrationLog: async (req, res, name) => {
            await global.guardGetWithUser(req);
            const { rows } = await global.DB.query(
                `SELECT * FROM migration_log WHERE db_name = $1 ORDER BY id ASC`, [name]);
            res.json(rows);
        },
        totalTaps: async (req, res) => {
            const { rows: [taps] } = await global.DB.query(`SELECT SUM(taps) FROM mictest`);
            res.json(taps);
        }
    },

    // routes completely replaces the built-in routes
    // routes: { foo: (_,res) => res.end('bar') }, // check out localhost:8000/foo

    // fallbackRoute is called when there's no matching route, the default is the static file server
    // fallbackRoute: async (req, res) => res.end("what was that?"),

    // Which migration to go to?
    migrationTarget: 'testing testing 1-2-3',

    // migrations adds to migrations
    migrations: [
        {
            name: 'is this on?',
            up: `CREATE TABLE mictest ( taps INT NOT NULL DEFAULT 1 );`,
            down: `DROP TABLE mictest;`
        },
        {
            name: 'testing testing 1-2-3',
            up: `
                INSERT INTO mictest (taps) VALUES (1);
                INSERT INTO mictest (taps) VALUES (2);
                INSERT INTO mictest (taps) VALUES (3);
            `,
            down: `DELETE FROM mictest;`
        }
    ]

    // replaceMigrations replaces the built-in migrations
    // replaceMigrations: [{ name: 'no need for db', up: 'select now()', down: 'select now()' }]
};
```

To check it out, make some self-signed certs and create the `mictest` database.

```bash
$ openssl req -x509 -newkey rsa:2048 -nodes -sha256 -subj '/CN=localhost' \
  -keyout localhost-privkey.pem -out localhost-cert.pem
$ createdb mictest
$ npx qframe ./mictest.js
```

Test the new API endpoints from another shell.

```bash
$ curl -k https://localhost:8000/_/hello; echo
{"hello":"world"}
$ curl -k https://localhost:8000/_/totalTaps; echo
{"sum":"6"}
$ curl --data-binary "who is it" -k https://localhost:8000/_/echo; echo
who is it
```

Then navigate to https://localhost:8000 and run the following in the console:

```javascript
var headers = {};
var get = async(path) => (await fetch(path, {headers})).json();
var post = async(path, body) => (await fetch(path, {method:'POST', headers, body: JSON.stringify(body)})).json();
headers = await post('/_/user/create', {email:'foo@bar', name: 'foo', password: 'bar'});
await get('/_/migrationLog/mictest')
```

## Tuning resource limits

More open files: `ulimit -n 20000` for more simultaneous connections.

The `node-postgres` `Pool` creates a bunch of connections for each worker,
`Pool` uses `10` connections per worker, unless you set the `max` property in the database config to lower this.
The default config uses `max: 3`.

On high core count systems, you might hit the default PostgreSQL `max_connections` limit of 100.
Edit `postgresql.conf` and set `max_connections` to CPU cores * workers * `Pool` config `max`.
