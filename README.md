# Qframe

Code-centric JSON API framework in 300 lines of easy-to-customize code.

Uses PostgreSQL as the database.


## Features

 * User accounts
 * Users have multiple items with CRUD
 * All API request bodies are JSON, all API responses are JSON
 * Routing
 * DB migrations
 * Multi-process cluster server with auto-restart
 * Fast iteration using nodemon to restart server on changes
 * Full SQL
 * Static file serving
 

## Usage

Create database and start server

```bash
    $ createdb qframe
    $ yarn && yarn nodemon .
```

Open http://localhost:8000 in your browser and try out the API in the console

```javascript
    var headers = {};
    var get = async(path) => (await fetch(path, {headers})).json();
    var post = async(path, body) => (await fetch(path, {method:'POST', headers, body: JSON.stringify(body)})).json();
    var user = await post('/user/create', {email:'foo@bar', name: 'foo', password: 'bar'});
    headers = await post('/user/authenticate', {email: 'foo@bar', password: 'bar'});
    var userData = await post('/user/edit/data', {avatar: "pirate", favouriteQuote: "Pinata Pirata!"});
    var {id} = await post('/items/create', {name: "My wonderful item", wonderfulness: 9999});
    var item = await get(`/items/view/${id}`);
    await post('/items/edit', {id, data: {name: "My wonderful item", wonderfulness: 10000}})
    var items = await get(`/items/list`);
    console.log(user, headers, userData, item, items);
```