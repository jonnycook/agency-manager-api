// 'use strict';

const Hapi = require('hapi');

var config = require('./config');

// var mongoose = require('mongoose');
// mongoose.Promise = require('bluebird');
// mongoose.connect(config.mongoConnection);

var Promise = require("bluebird");
var MongoDB = require("mongodb");
Promise.promisifyAll(MongoDB);

var JSON = require('json-stringify-date');

var db;
MongoDB.MongoClient.connect(config.mongoConnection).then((a) => {
  db = a;
});


// var Activity = mongoose.model('Activity', mongoose.Schema({
//   name: String,
//   category: String,
//   done: Boolean,
// }));

// Create a server with a host and port
const server = new Hapi.Server();
server.connection({ 
  // host: 'localhost', 
  port: 8000,
  routes: { cors: true }
});

var prefix = '/v1/';

// function create(model) {
//   return {
//     method: 'POST',
//     path: `${prefix}${model.collection.name}`,
//     handler: async function(request, reply) {
//       var obj = new model(request.payload);
//       obj.save();
//       reply(obj);
//     }
//   }
// }

// function update(model) {
//   return {
//     method: 'PATCH',
//     path: `${prefix}${model.collection.name}/{id*1}`,
//     handler: async function(request, reply) {
//       reply(await model.findByIdAndUpdate(request.params.id, { $set: request.payload }, { new: true }).exec());
//     }
//   }
// }

// function list(model, populate=[]) {
//   return {
//     method: 'GET',
//     path: `${prefix}${model.collection.name}`,
//     handler: async function (request, reply) {
//       reply(await model.find().populate(populate));
//     }
//   };
// }

// function remove(model) {
//   return {
//     method: 'DELETE',
//     path: `${prefix}${model.collection.name}/{id*1}`,
//     handler: async function (request, reply) {
//       reply(await model.findByIdAndRemove(request.params.id).exec());
//     }
//   };
// }

async function auth(token) {
  return (await (await db.collection('users').find({authKey:token})).toArray()).length;
}

server.route([
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
      var mutation = payload.mutation;
      var collection = db.collection(payload.collection);
      if (mutation.type == 'set') {
        await collection.update({ _id: payload._id }, {
          $set: {
            [mutation.path.join('.')]: mutation.value
          }
        }, { upsert: true });
        reply(true);
      }
      else if (mutation.type == 'unset') {
        await collection.update({ _id: payload._id }, {
          $unset: {
            [mutation.path.join('.')]: ''
          }
        }, { upsert: true });
        reply(true);
      }
      else if (mutation.type == 'remove') {
        let deleteKey = Math.random();
        await collection.update({ _id: payload._id }, {
          $set: { [mutation.path.concat(mutation.index).join('.')]: deleteKey }
        });
        await collection.update({ _id: payload._id }, {
          $pull: { [mutation.path.join('.')]: deleteKey }
        });
        reply(true);
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
        reply(true);
      }
      else if (mutation.type == 'create') {
        await collection.insert(mutation.document);
        reply(true);
      }
      else if (mutation.type == 'delete') {
        await collection.update({ _id: payload._id }, { $set: {_deleted: true} });
        reply(true);
      }
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
