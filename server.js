// 'use strict';

const Hapi = require('hapi');

var config = require('./config');
var Promise = require("bluebird");
var MongoDB = require("mongodb");
Promise.promisifyAll(MongoDB);

var JSON = require('json-stringify-date');

var WebSocket = require('ws');
var wss = new WebSocket.Server({ port: 8080 });

var sockets = [];

var db;
MongoDB.MongoClient.connect(config.mongoConnection).then((a) => {
  db = a;
});


async function auth(token) {
  return (await (await db.collection('agency_users').find({authKey:token})).toArray()).length;
}


async function handleClientPush(payload) {
  var mutation = payload.mutation;
  var collection = db.collection(payload.collection);

  if (mutation.path) {
    for (let comp of mutation.path) {
      if (comp[0] == '&') {
        var doc = await collection.findOne({ _id: payload._id });

        var obj = doc;
        for (var i = 0; i < mutation.path.length; ++ i) {
          let comp = mutation.path[i];
          if (comp[0] == '&') {
            var id = comp.substr(1);
            var index = obj.findIndex((el) => el._id == id);
            mutation.path[i] = index;
            obj = obj[index];
          }
          else {
            obj = obj[comp];
          }
        }
        break;
      }
    }
  }

  if (mutation.type == 'set') {
    await collection.update({ _id: payload._id }, {
      $set: {
        [mutation.path.join('.')]: mutation.value
      }
    }, { upsert: true });
    return true;
  }
  else if (mutation.type == 'unset') {
    await collection.update({ _id: payload._id }, {
      $unset: {
        [mutation.path.join('.')]: ''
      }
    }, { upsert: true });
    return true;
  }
  else if (mutation.type == 'remove') {
    let deleteKey = Math.random();

    if (mutation.key) {
      await collection.update({ _id: payload._id }, {
        $pull: { [mutation.path.join('.')]: { _id: mutation.key } }
      });
    }
    else {
      await collection.update({ _id: payload._id }, {
        $set: { [mutation.path.concat(mutation.index).join('.')]: deleteKey }
      });
      await collection.update({ _id: payload._id }, {
        $pull: { [mutation.path.join('.')]: deleteKey }
      });

    }
    return true;
  }
  else if (mutation.type == 'insert') {
    var path = mutation.path.slice(0, -1);
    var index = mutation.path[mutation.path.length - 1];
    await collection.update({ _id: payload._id }, {
      $push: {
        [path.join('.')]: {
          $each: [ mutation.el ],
          $position: index
        }
      }
    });
    return true;
  }
  else if (mutation.type == 'create') {
    await collection.insert(mutation.document);
    return true;
  }
  else if (mutation.type == 'delete') {
    await collection.update({ _id: payload._id }, { $set: {_deleted: true} });
    return true;
  }
}


wss.on('connection', (ws) => {
  console.log('new connection');
  sockets.push(ws);
  ws.on('message', async (data) => {
    var message = JSON.parse(data);
    if (message.type == 'subscribe') {
    }
    else if (message.type == 'push') {
      if (!(await auth(message.authKey))) {
        ws.close();
      }
      handleClientPush(message.payload);
      for (let ws2 of sockets) {
        if (ws2 != ws) {
          ws2.send(data);
        }
      }
    }
  });

  ws.on('close', () => {
    console.log('closed');
    sockets.splice(sockets.indexOf(ws), 1);
  });
});

// Create a server with a host and port
const server = new Hapi.Server();
server.connection({ 
  // host: 'localhost', 
  port: 8000,
  routes: { cors: {
        headers: ['Accept', 'Authorization', 'Content-Type', 'If-None-Match', 'authentication']
      } }
});

var prefix = '/v1/';


server.route([
  {
    method: 'GET',
    path: `${prefix}clients/push`,
    handler: async function(request, reply) {
      console.log(request.query);
      for (var ws of sockets) {
        ws.send(request.query.message);
      }
      reply(true);
    }
  },
  {
    method: 'POST',
    path: `${prefix}login`,
    handler: async function(request, reply) {
      var doc = await db.collection('agency_users').findOne({email:request.payload.email, password:request.payload.password});
      if (doc) {
        reply(doc.authKey);
      }
      else {
        reply(false);
      }
    }
  },
  {
    method: 'POST',
    path: `${prefix}push`,
    config: {
      payload: {
        parse: false
      },
    },
    handler: async function(request, reply) {
      if (!(await auth(request.headers.authentication))) return reply(false);
      var payload = JSON.parse(request.payload);
      reply(await handleClientPush(payload));
    }
  },
  {
    method: 'GET',
    path: `${prefix}pull`,
    handler: async function(request, reply) {
      if (!(await auth(request.headers.authentication))) return reply(false);
      var collections = {};
      for (var collection of await db.collections()) {
        collections[collection.collectionName] = await (await collection.find({_deleted:null})).toArray();
      }
      return reply(JSON.stringify(collections)).type('application/json');
    }
  }
]);


// Start the server
server.start((err) => {
  if (err) {
    throw err;
  }
  console.log('Server running at:', server.info.uri);
});
