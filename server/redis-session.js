// https://github.com/mitchellsimoens/redis-session

var redis = require('redis');

module.exports = function(config) {
    var mod = this;

    mod.objMerge = function(obj1, obj2) {
        if (obj2) {
            var key, value;

            for (key in obj2) {
                if (obj2.hasOwnProperty(key)) {
                    value = obj2[key];

                    try {
                        // Property in destination object set; update its value.
                        if ( value.constructor === Object ) {
                            obj1[key] = mod.objMerge(obj1[key], value);
                        } else {
                            obj1[key] = value;
                        }
                    } catch(e) {
                        // Property in destination object not set; create it and set its value.
                        obj1[key] = value;
                    }
                }
            }
        }

        return obj1;
    };

    /**
     * CONFIG SECTION
     * You shouldn't change these but pass in when you create this module:
     *
     *    var session = require('redis-session')({
     *        ttl   : 300000 * 5,
     *        debug : true
     *    });
     */
    config = mod.config = mod.objMerge({
        /**
         * The time to live for the session in milliseconds
         */
        ttl        : 900000, // 15min
        /**
         * true to enable debug mode
         */
        debug      : true,
        /**
         * The number of characters to create the session ID.
         */
        sidLength  : 40,
        /**
         * If persist is false, it will expire after the ttl config.
         * If persist is true, it will never expire and ttl config will be ignored.
         */
        persist    : false,
        /**
         * REDIS connection information
         */
        connection : {
            port : '6379',
            host : '127.0.0.1'
        }
    }, config);

    mod.objMerge(mod, {
        // @private
        _connect : function() {
            var options = config,
                client  = mod.client;

            if (client) {
                return client;
            }

            client = mod.client = new redis.createClient(options.port, options.host, options);

            if (options.pass) {
                client.auth(options.pass, function(err) {
                    if (err) {
                        throw err;
                    }
                });
            }

            if (options.db) {
                client.select(options.db);

                client.on('connect', function() {
                    client.send_anyways = true;

                    client.select(options.db);

                    client.send_anyways = false;
                });
            }

            return client;
        },

        // @private
        _createSid : function(req, data, callback) {
            var client = mod._connect(),
                chars  = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXTZabcdefghiklmnopqrstuvwxyz',
                cLen   = chars.length,
                len    = config.sidLength,
                sid    = '',
                i      = 0,
                rNum;

            for (; i < len; i++) {
                rNum = Math.floor(Math.random() * cLen);

                sid += chars.substring(rNum, rNum + 1);
            }

            client.exists(sid, function(err, exists) {
                if (err && config.debug) {
                    console.error('----_createSid ERROR');
                    console.error(err);
                }

                if (exists === 1) {
                    mod._createSid(req, data, callback);
                } else {
                    mod.createSet.call(mod, req, sid, data, callback);
                }
            });
        },

        create : function(req, data, callback) {
            data = data || {};

            var sid = data.sid;

            if (sid) {
                //session active?
                client.exists(sid, function(err, exists) {
                    if (err && config.debug) {
                        console.error('----_createSid ERROR');
                        console.error(err);
                    }

                    if (exists === 1) {
                        mod._createSid(req, data, callback);
                    } else {
                        mod.createSet.call(mod, req, sid, data, callback);
                    }
                });
            } else {
                mod._createSid.call(mod, req, data, callback);
            }
        },

        createSet : function(req, sid, data, callback) {
            var ttl         = config.ttl,
                persist     = config.persist,
                client      = mod._connect(),
                info        = JSON.stringify(data),
                setCallback = function(err, status) {
                    if (!err) {
                        data.sid        = sid;
                        req.sessionData = data;
                    } else if (config.debug) {
                        console.error('----createSet ERROR');
                        console.error(err);
                    }

                    callback && callback.call(mod, sid, err, status);
                };

            if (persist) {
                client.set(sid, info, setCallback);
            } else {
                client.setex(sid, ttl, info, setCallback);
            }
        },

        get : function(sid, req, callback) {
            var client = mod._connect();

            if (!sid) {
                callback && callback.apply(mod, [null, true, 'no sid given']);
                return;
            }

            client.get(sid, function(err, info) {
                if (err && config.debug) {
                    console.error('----get ERROR');
                    console.error(err);
                    info = err;
                    err  = true;
                } else if (info) {
                    var data = JSON.parse(info.toString());

                    data.sid        = sid;
                    req.sessionData = data;
                }

                callback && callback.apply(mod, [data, err, info]);
            });
        },

	set : function(sid, properties, req, callback) {
	    var that = this;
	    this.get(sid, req, function _setGetCallback (data, err, info) {
		if (err) {
		    return callback(data, err, info);
		}
		if (typeof properties != 'object') {
		    return callback(null, 'properties should be object type');
		}
		for (var prop in properties) {
                    data[prop] = properties[prop];
		}
		// Save new properties to session storage
		that.createSet(req, sid, data, callback);
	    });
	},

	rmProp : function(sid, propArr, req, callback) {
	    var that = this;
	    this.get(sid, req, function _setGetCallback (data, err, info) {
		if (err) {
		    return callback(data, err, info);
		}
		if (!propArr.length) {
		    return callback(null, 'properties array sould not be empty');
		}
		for (var i=0; i < propArr.length; i++) {
		    var prop = propArr[i];
                    if (data[prop]) {
			delete data[prop];
		    }
		}
		// Save new properties to session storage
		that.createSet(req, sid, data, callback);
		// XXXddahl: create new API called update()? instead?
	    });
	},

        clear : function(sid, req, callback) {
            req.sessionData = null;

            this.client.del(sid, callback);
        },

        getAllKeys : function(req, callback) {
            var client = mod._connect();

            if (!config.debug) {
                console.log('you cannot call getAllKeys when not in debug mode');
                callback && callback.call(mod);
                return;
            }

            client.keys('*', function(err, keys) {
                callback && callback.call(mod, keys);
            });
        },

        clearAll : function(req, callback) {
            var client = mod._connect();

            if (!config.debug) {
                console.log('You cannot call clearAll when not in debug mode');
                callback && callback.call(mod);
                return;
            }

            client.flushall(function() {
                callback && callback.apply(mod, arguments);
            });
        },

        validateSessionId : function(sid) {
          // XXXddahl TODO: decrypt SessionID with current secret & IV
          // Assumption here is that  we can generate a new
          // random IV and secret each time the server starts
        }
    });

    return mod;
};
