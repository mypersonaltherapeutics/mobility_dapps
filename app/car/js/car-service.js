const series = require('async/series');
const geolib = require('geolib');
const GPS = require('gps');                                                       
const IPFS = require('ipfs');
const ipfsAPI = require('ipfs-api')
const mqtt = require('mqtt');
const multiaddr = require('multiaddr')
const os = require('os')
const path = require('path')
const SerialPort = require('serialport');                                         
const Web3 = require('web3');

const appcommon = require('../../common/js/app-common');
const keyfob = require('./keyfob');

/**
 * The in-car service class.
 * @constructor
 */
function CarService() {
    var self = this;
    
    self.ipfsRunning = false;
   
    self.gps = new GPS;                                                              
    self.gpsFixed = false;
    self.gpsRunning = false;
    

    self._keyfob = keyfob; 
    // -$- Some default values for display and ipfs -$-
    self.locked = 'unknown';
    self.loc = {
        time: 1495050105, 
        lat: 37.263056,
        lon: -115.79302,
        alt: 0
    };
    self.speed = 0;
}

/**
 * Initialize and start IPFS node.
 */
CarService.prototype.startIpfs = function(repo, callback) {
    var self = this;
    series([
        (cb) => {
            self.ipfsNode = new IPFS({
                repo: repo, 
                init: false,
                start: false,
                EXPERIMENTAL: {
                    pubsub: true,
                    //sharding: true
                },
            });
            cb();
        /*
            self.ipfsNode.version((err, version) => {
                if (err) { return cb(err) }
                console.log('\nIPFS Version:', version.version);
                cb();
            })
        */
        },
        (cb) => {
            self.ipfsNode._repo.exists((err, exists) => {
                if (err) return cb(err);
                if (exists) self.ipfsNode.on('ready', cb);
                else self.ipfsNode.init({ emptyRepo: true, bits: 2048}, cb);
            });
        },
        (cb) => self.ipfsNode.start(cb),
        (cb) => {
            if (!self.ipfsNode.isOnline()) return cb('error bringing ipfs online');
            self.ipfsRunning = true;
            self.ipfsNode.id((err, identity) => {
                if (err) return cb(err);
                console.log('IPFS node id ' + identity.id);
                self.ipfsNodeId = identity.id;
                cb();
            });
        },
        // -$- Connect to bootstrap peers -$-
        (cb) => {
            self.ipfsNode.swarm.connect(appcommon.Configs.IPFS_Bootstrap_Peers[0], 
                    function (error) { 
                if (error) cb(error);
                cb();
            });
        },
        (cb) => {
            self.ipfsNode.swarm.peers((err, peerInfos) => {
                if (err) cb(err);
                //console.log(peerInfos);
                cb();
            });
        }
        
    ], (err) => {
        if (err) {
            return callback(err);
        }
        callback();
    });

}

/**
 * Initialize and connect IPFS service.
 * @param {dict} connectionOpts The connection configurations.
 * @param cb The callback to indicate finish.
 */
CarService.prototype.startIpfsApi = function(connectionOpts, cb) {
    var self = this;
    self.ipfsNode = ipfsAPI(connectionOpts);
    self.ipfsNode.id((err, identity) => {
        if (err) return cb(err);
        console.log('\nIPFS node id ' + identity.id);
        self.ipfsNodeId = identity.id;
        cb();
    });

}

/**
 * Listen to the car command topic from IPFS P2P pubsub network.
 * @param msgReceiver Callback function to process topic data.
 * @param cb Callback to indicate subcribed status.
 */
CarService.prototype._subscribe2IPFSCarTopic = function(topic, msgReceiver, cb) {
    var self = this;
    if (!self.ipfsRunning) {
        return console.log('Error: IPFS node is not online!');
    }
    self.ipfsNode.pubsub.subscribe(topic, {discover: true}, msgReceiver);
    console.log('\nSubscribed to %s in IPFS.', topic);
    cb();
}

CarService.prototype._subscribe2MQTTCarTopic = function(topic, msgReceiver, cb) {
    var self = this;
    client = mqtt.connect(appcommon.Configs.MQTT_Broker_TCP);
    client.on('connect', () => {
        client.subscribe(topic);
        console.log('\nSubscribed to %s from MQTT.', topic);
        cb();
    });
    client.on('message', msgReceiver);

}

/**
 * Listen for car topic through pub/sub network.
 * @param {String} M2MProtocol The M2M network to use, supports 'MQTT' and 'IPFS'.
 * @param {String} topic The topic to subscribe.
 * @param msgReceiver The callback to process data.
 * @param cb The callback to indicate finish of subscription.
 */
CarService.prototype.listenCarTopic = function(M2MProtocol, topic, msgReceiver, cb) {
    var self = this;
    switch (M2MProtocol) {
        case 'MQTT': 
            self._subscribe2MQTTCarTopic(topic, msgReceiver, cb); 
            break;
        case 'IPFS': 
            self._subscribe2IPFSCarTopic(topic, msgReceiver, cb); 
            break;
        default: 
            throw new Error('M2M protocol %s not supported!', m2mProtocol);
    }
}

/**
 * Start listening GPS data.
 */
CarService.prototype.startGPSData = function() {
    var self = this;
    if (typeof self.gpsport === 'undefined') {
        self.gpsport = new SerialPort('/dev/ttyS0', {                                       
            baudrate: 9600,                                                             
            parser: SerialPort.parsers.readline('\r\n')                                 
        });
    }

    self.gpsport.on('data', function(data) {                                                
        self.gps.update(data);                                                           
    });

    self.gps.on('data', function(data) {                                                  
        // or on GGA
        var state = self.gps.state;
        if (state.fix !== null) {
            self.gpsFixed = true;
            self.loc = {
                time: new Date(state.time).getTime(),
                lat: state.lat,
                lon: state.lon,
                alt: state.alt
            };
            self.speed = state.speed;
            //console.log(self.loc, self.speed);
        } else {
            self.gpsFixed = false;
        }
    });
    self.gpsListening = true;
    console.log('\nStart sharing GPS data.');
}

/**
 * Execute car command.
 * @param {String} command The name of the command.
 */
CarService.prototype.execCmd = function (command) {
    var self = this;
    switch(command) {
        case 'lock':
            console.log('\nLocking...');
            self._keyfob.lock();
            self.locked = true;
            break;
        case 'unlock':
            console.log('\nUnlocking...');
            self._keyfob.unlock();
            self.locked = false;
            break;
        default:
            console.log('\nUnsupported car command %s.', msg.cmd);
    }
}

/**
 * Stop car service.
 */
CarService.prototype.stopService = function() {
    var self = this;
    series([
        (cb) => {
            if (self.ipfsRunning) {
                self.ipfsNode.stop(cb);
            } else {
                cb();
            }
        },
        (cb) => {
            if (self.gpsListening) {
                self.gps.off('GGA');
                self.gpsport.off('data');
            } 
            cb();
        }
    ], (err) => {
        if (err) return console.log(err);
        console.log('Car service stopped.');
    });
}

module.exports = CarService;

