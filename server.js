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

var Sugar = require('sugar');

Sugar.extend();

var db;
MongoDB.MongoClient.connect(config.mongoConnection).then((a) => {
  db = a;
});


async function auth(token) {
  var user = (await (await db.collection('agency_users').find({authKey:token})).toArray())[0];
  if (user) {
    return user._id;
  }
}

var Collection = {
  removeDocument(name, doc) {
    db[name].splice(db[name].findIndex(d => d._id === doc._id), 1);
  },
  async findById(name, id) {
    return (await (await db.collection(name).find({_id:id})).toArray())[0];
  },
  async find(name, query) {
    return await (await db.collection(name).find(query)).toArray();
  }
}


var Models = {
  Relationship: {
    otherRelIndex(rel, entity) {
      if (rel.entities[0] === entity._id) {
        return 1;
      }
      else {
        return 0;
      }
    }

  },
  Entity: {
    async relatedEntities(entity, type=null, startPoint=null) {
      async function relationships() {
        if (startPoint === null) {
          return await Collection.find('relationships', { entities: entity._id });
        }
        else if (startPoint === true) {
          return await Collection.find('relationships', { 'entities.0': entity._id, directed: true });
        }
        else if (startPoint === false) {
          return await Collection.find('relationships', { 'entities.1': entity._id, directed: true });
        }
      }

      async function relatedEntity(rel) {
        var id = rel.entities[Models.Relationship.otherRelIndex(rel, entity)];
        // return id;
        if (id) {
          return await Collection.findById('entities', id);
        }
      }

      var rels = await relationships(startPoint);
      var entities = [];

      for (var rel of rels) {
        entities.push(await relatedEntity(rel));
      }

      if (type) {
        return entities.filter((e) => e.type === type);
      }
      else {
        return entities;
      }
    },

    property(entity, name) {
      return (entity.properties.find((e) => e.name === name) || {}).value;
    },
    state(entity, name) {
      return entity.state ? (entity.state.find((e) => e.name === name) || {}) : {}
    },
    async display(entity, showType=true) {
      if (entity) {
        var func = {
          async Call() {
            var date = Models.Entity.property(entity, 'Date');
            if (date && date.format) {
              var parent = (await Models.Entity.relatedEntities(entity, null, false))[0];
              var label = date.format('{yyyy}-{MM}-{dd}');
              if (parent) {
                return (await Models.Entity.display(parent, false)) + '/' + label;
              }
            }
          },
          async Workload() {
            var month = Models.Entity.property(entity, 'Month');
            var parent = (await Models.Entity.relatedEntities(entity, null, false))[0];
            var label = month;
            if (parent) {
              return (await Models.Entity.display(parent, false)) + '/' + label;
            }
          }
        }[entity.type];

        var label;



        if (func) {
          label = await func();
        }
        

        if (!label) {
          var properties = {};
          var e = entity;
          while (true) {
            for (var prop of e.properties) {
              if (!(prop.name in properties)) {
                if (prop.type == 'date') {
                  properties[prop.name] = prop.value.format('{yyyy}-{MM}-{dd}');
                }
                else {
                  properties[prop.name] = prop.value;                  
                }
              }
            } 
            if (e.extends) {
              e = await Collection.findById('entities', e.extends);
            }
            else {
              break;
            }
          }

          // var label = [];
          // for (var propName of Object.keys(properties)) {
          //   label.push(`${propName}: ${properties[propName]}`);
          // }

          label = properties.Name ? properties.Name : Object.values(properties)[0];

        }


        return showType ? `${label} (${entity.type})` : label;
      }
      else {
        return '(none)';
      }
    }
  }
}


async function handleClientPush(payload, user) {
  var mutation = payload.mutation;
  var collection = db.collection(payload.collection);

  var originalPath
  var prev;
  if (mutation.path) {
    originalPath = mutation.path.clone();
    var doc = await collection.findOne({ _id: payload._id });
    var obj = doc;
    for (var i = 0; i < mutation.path.length; ++ i) {
      let comp = mutation.path[i];
      if (comp[0] == '&') {
        var id = comp.substr(1);
        var index = obj.findIndex((el) => el._id == id);
        mutation.path[i] = index;
        prev = obj = obj[index];
      }
      else {
        prev = obj = obj[comp];
      }
    }
  }

  if (mutation.type == 'set') {
    await collection.update({ _id: payload._id }, {
      $push: {
        ['_history.' + originalPath.join('.') + '._']: {
          operation: 'set',
          value: prev,
          timestamp: new Date(),
          user: user
        }
      },
      $set: {
        [mutation.path.join('.')]: mutation.value
      }
    }, { upsert: true });
    return true;
  }
  else if (mutation.type == 'unset') {
    await collection.update({ _id: payload._id }, {
      $push: {
        ['_history.' + originalPath.join('.') + '._']: {
          operation: 'unset',
          value: prev,
          timestamp: new Date(),
          user: user
        }
      },
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
        $push: {
          ['_history.' + originalPath.concat('&' + mutation.key).join('.') + '._']: {
            operation: 'remove',
            value: prev.find((el) => el._id == mutation.key),
            timestamp: new Date(),
            user: user
          }
        },
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
        ['_history.' + originalPath.slice(0, -1).concat('&' + mutation.el._id).join('.') + '._']: {
          operation: 'insert',
          value: null,
          timestamp: new Date(),
          user: user
        },
        [path.join('.')]: {
          $each: [ mutation.el ],
          $position: index
        }
      }
    });
    return true;
  }
  else if (mutation.type == 'create') {
    mutation.document._created = { timestamp: new Date(), user };
    await collection.insert(mutation.document);
    return true;
  }
  else if (mutation.type == 'delete') {
    await collection.update({ _id: payload._id }, { $set: {_deleted: { timestamp: new Date(), user }} });
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
      var user;
      if (!(user = await auth(message.authKey))) {
        ws.close();
      }
      handleClientPush(message.payload, user);
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


async function timerData(subject) {
  var objects = [];

  var entities = await (await db.collection('entities').find({_deleted:null, })).toArray();
  for (var entity of entities) {
    var name = await Models.Entity.display(entity, false);
    if (typeof Models.Entity.property(entity, 'Activity') != 'undefined') {
    objects.push({
      label: name,
      _id: { entity: entity._id }
    });

    }
  }

  // var issues = await (await db.collection('issues').find({_deleted:null, completed:null})).toArray();
  // for (var issue of issues) {
  //   objects.push({
  //     label: issue.description,
  //     _id: { issue: issue._id }
  //   });
  // }

  // var tasks = await (await db.collection('tasks').find({_deleted:null, completed:null})).toArray();
  // for (var task of tasks) {
  //   objects.push({
  //     label: task.title,
  //     _id: { task: task._id }
  //   });
  // }


  for (var object of objects) {
    object._id = new Buffer(JSON.stringify(object._id)).toString('base64');
  }

  var timers = [];

  var grouped = {};
  var entries = await (await db.collection('work_log_entries').find({ _deleted:null, subject, start: { $gte: new Date().beginningOfDay(), $lt: new Date().endOfDay() } }).sort({start:-1})).toArray();

  for (let entry of entries) {
    let key = JSON.stringify(entry.activity);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(entry);
  }

  for (let key in grouped) {
    let time = 0;
    var started = null;
    for (let entry of grouped[key]) {
      if (entry.end) {
        time += Math.floor((entry.end.getTime() - entry.start.getTime())/1000);
      }
      else {
        started = entry.start;
      }
    }

    let entry = grouped[key][0];
    var label;
    if (entry.activity.object.entity) {
      var entity = await db.collection('entities').findOne({ _id: entry.activity.object.entity });
      label = await Models.Entity.display(entity);
    }
    else {
      label = 'adsf';
    }

    timers.push({
      label: label + ' - ' + entry.activity.activity,
      time: time + '',
      default: entries.length && entries[0]._id == entry._id ? 'true' : undefined,
      started: started ? (Math.floor(started.getTime()/1000) + '') : undefined,
      object: new Buffer(JSON.stringify(entry.activity.object)).toString('base64'),
      activity: entry.activity.activity
    });
  }

  timers.sort((a, b) => {
    if (a.label < b.label) return -1;
    else return 1;
  })

  return {
    activities: ['Communication', 'Development', 'Management', 'Estimation', 'Scoping', /*'Importing', */'Orienting'],
    objects: objects.sort((a, b) => a.label < b.label ? -1 : 1),
    timers: timers,
  };
}

server.route([
  {
    method: 'GET',
    path: `${prefix}timer`,
    handler: async function(request, reply) {

      try {
        reply(await timerData('59c309ff8111cc00006e9e61'));  
      }
      catch (e) {
        console.log(e);
      }
      
    }
  },
  {
    method: 'POST',
    path: `${prefix}timer`,
    handler: async function(request, reply) {

      var subject = '59c309ff8111cc00006e9e61';
      

      var activity = {
        activity: request.payload.activity,
        object: JSON.parse(new Buffer(request.payload.object, 'base64').toString('ascii'))
      }

      var doc = await db.collection('work_log_entries').findOne({_deleted: null, subject: subject, activity: activity, end: null});
      if (doc) {
        handleClientPush({
          collection: 'work_log_entries',
          _id: doc._id,
          mutation: {
            type: 'set',
            path: ['end'],
            value: new Date()
          }
        }, subject);
      }
      else {
        // await db.collection('work_log_entries').insert({subject: subject, activity: activity, start: new Date()});
        handleClientPush({
          collection: 'work_log_entries',
          mutation: {
            type: 'create',
            document: {
              _id: new MongoDB.ObjectID().toString(),
              subject: subject, activity: activity, start: new Date()
            }
          }
        }, subject);
      }

      reply(await timerData(subject));
    }
  },

  {
    method: 'GET',
    path: `${prefix}data`,
    handler: async function(request, reply) {
      var entity = await db.collection('entities').findOne({_id: request.query.entity});

      var response = {
        data: entity.data.find((data) => data._id == request.query.data),
        entity: await Models.Entity.display(entity, false)
      }

      reply(response);
    }
  },

  {
    method: 'PUT',
    path: `${prefix}data`,
    handler: async function(request, reply) {
      var subject = '59c309ff8111cc00006e9e61';
      handleClientPush({
        collection: 'entities',
        _id: request.query.entity,
        mutation: {
          type: 'set',
          path: ['data', '&' + request.query.data, 'content', 'body'],
          value: request.payload.data
        }
      }, subject);
      reply(true);
    }
  },

  {
    method: 'GET',
    path: `${prefix}clients/push`,
    handler: async function(request, reply) {
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
      try {
        var user;
        if (!(user = await auth(request.headers.authentication))) return reply(false);
        var payload = JSON.parse(request.payload);
        reply(await handleClientPush(payload, user));        
      }
      catch (e) {
        console.log(e);
        reply(false);
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
        collections[collection.collectionName] = await (await collection.find({_deleted:null}, {_history: 0})).toArray();
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
