'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const querystring = require('querystring');

const farmhash = require('farmhash');
const HashRing = require('hashring');
const request = require('request');
const finalhandler = require('finalhandler');
const serveStatic = require('serve-static');

// Parse TTL from a Cache-Control response header, in seconds, defaulting to 0
const ttlFromCacheControlHeader = function(cacheControlHeader) {
  let ttl = 0;
  if (
    typeof cacheControlHeader === 'string' &&
    cacheControlHeader.indexOf('no-cache') === -1 &&
    cacheControlHeader.indexOf('private') === -1
  ) {
    const smaxage = cacheControlHeader.match(/s-maxage=([0-9]+)/);
    if (smaxage) {
      ttl = parseInt(smaxage[1], 10);
    } else {
      const maxage = cacheControlHeader.match(/max-age=([0-9]+)/);
      if (maxage) {
        ttl = parseInt(maxage[1], 10);
      }
    }
  }
  return ttl;
};

// FileLocker object

const FileLocker = function() {
  this.lockedFiles = new Map();
};
const locker = new FileLocker();

FileLocker.prototype.lock = function(file, proceed) {
  if (this.lockedFiles.has(file)) {
    // Added request to existing lock
    this.lockedFiles.get(file).onRelease.push(proceed);
  } else {
    // Create new lock for file
    this.lockedFiles.set(file, {
      lastUpdated: Date.now(),
      onRelease: []
    });
    // Allow this first request to proceed
    proceed();
  }
};

FileLocker.prototype.unlock = function(file) {
  if (this.lockedFiles.has(file)) {
    if (this.lockedFiles.get(file).onRelease.length > 0) {
      // Transfer lock
      this.lockedFiles.get(file).lastUpdated = Date.now();
      this.lockedFiles.get(file).onRelease.shift()();
    } else {
      // Remove empty lock
      this.lockedFiles['delete'](file);
    }
  }
};

// Petra object

const Petra = function(options) {
  const self = this;
  // Parse options
  this.port = options.port || 8209;
  this.minimumTtl = options.minimumTtl || 7 * 24 * 60 * 60;  // 7 days, in seconds
  this.cachePurgeInterval = options.cachePurgeInterval || 60 * 60;  // 1 hour, in seconds
  this.mediaTypes = options.mediaTypes || [];
  this.log = options.log || function(msg) {
    console.log((new Date()).toISOString() + ' petra ' + msg);
  };
  this.debug = options.debug || false;
  // Cache directory
  this.cacheDirectory = options.cacheDirectory || path.join(os.tmpdir(), 'petra');
  fs.mkdir(this.cacheDirectory, '0755', function(err) {
    if (err && err.code !== 'EEXIST') {
      throw new Error('Could not create cacheDirectory ' + err.message);
    }
  });
  // Hash ring
  if (Array.isArray(options.ring)) {
    this.hashring = new HashRing(options.ring);
    // Discover external IPv4 addresses
    const externalIPv4Addresses = (function() {
      const interfaces = os.networkInterfaces();
      return Object.keys(interfaces).map(function(name) {
        return interfaces[name].filter(function(item) {
          // Filter to include only IPv4 and external
          return (item.family === 'IPv4' && item.internal === false);
        }).map(function(item) {
          // Return the matching addresses
          return item.address;
        });
      }).reduce(function(a, b) {
        // Flatten array
        return a.concat(b);
      });
    })();
    // Verify hash ring contains exactly one of my external IPv4 addresses
    const myIpAddresses = options.ring.filter(function(entry) {
      return (externalIPv4Addresses.indexOf(entry) !== -1);
    });
    if (myIpAddresses.length === 1) {
      this.whoami = myIpAddresses[0];
    } else {
      throw new Error('Hash ring ' + options.ring + ' must contain exactly one of my IPv4 addresses ' + externalIPv4Addresses);
    }
  }
  // Start HTTP server
  http.createServer(function(req, res) {
    self.serve(req, res);
  }).listen(this.port, this.whoami);
  this.serveStatic = serveStatic(this.cacheDirectory, {etag: false, index: false});
  // Start purge cache task
  this.purgeCacheTask = setInterval(
    function() {
      self.purgeCache(self.cacheDirectory);
    },
    this.cachePurgeInterval * 1000
  );
};
module.exports = Petra;

Petra.prototype.cacheFilePath = function(bucket, fingerprint) {
  if (typeof bucket === 'string' && bucket.length !== 0) {
    return path.join(this.cacheDirectory, bucket, fingerprint);
  } else {
    return path.join(this.cacheDirectory, fingerprint);
  }
};

Petra.prototype.fetch = function(upstreamUrl, bucket, done) {
  const self = this;
  // Bucket
  if (typeof bucket === 'function' && typeof done === 'undefined') {
    // No bucket required
    done = bucket;
    bucket = '';
  }
  // Fingerprint and filename
  const fingerprint = farmhash.fingerprint64(upstreamUrl);
  const filename = self.cacheFilePath(bucket, fingerprint);
  // Lock
  locker.lock(filename, function() {
    // Check local filesystem
    self.fetchFromFilesystem(bucket, filename, function(err, filesystemHit, atime, mtime) {
      if (err) {
        // Filesystem error
        if (self.debug) {
          self.log('Filesystem error ' + filename + ' ' + err.message);
        }
        done(err);
        locker.unlock(filename);
      } else if (filesystemHit) {
        // Filesystem hit
        if (self.debug) {
          self.log('Filesystem hit ' + filename);
        }
        locker.unlock(filename);
        done(null, filename, atime, mtime);
      } else {
        // Filesystem miss
        if (self.debug) {
          self.log('Filesystem miss ' + filename);
        }
        // Check peer
        self.fetchFromPeer(bucket, fingerprint, filename, function(err, peerHit, atime, mtime) {
          if (err) {
            // Peer error
            if (self.debug) {
              self.log('Peer error ' + filename + ' ' + err.message);
            }
            done(err);
            locker.unlock(filename);
          } else if (peerHit) {
            // Peer hit
            if (self.debug) {
              self.log('Peer hit ' + filename);
            }
            locker.unlock(filename);
            done(null, filename, atime, mtime);
          } else {
            // Peer miss
            if (self.debug) {
              self.log('Peer miss ' + filename);
            }
            // Check upstream
            self.fetchFromUpstream(upstreamUrl, bucket, fingerprint, filename, function(err, upstreamHit, atime, mtime) {
              if (err) {
                // Upstream error
                if (self.debug) {
                  self.log('Upstream error ' + filename + ' ' + err.message);
                }
                done(err);
                locker.unlock(filename);
              } else if (upstreamHit) {
                // Upstream hit
                if (self.debug) {
                  self.log('Upstream hit ' + filename);
                }
                locker.unlock(filename);
                done(null, filename, atime, mtime);
              } else {
                // Upstream miss
                if (self.debug) {
                  self.log('Upstream miss ' + filename);
                }
                done(new Error('404'));
                locker.unlock(filename);
              }
            });
          }
        });
      }
    });
  });
};

Petra.prototype.fetchFromFilesystem = function(bucket, filename, done) {
  const self = this;
  fs.stat(filename, function(err, stats) {
    if (err && err.code === 'ENOENT') {
      // Cache miss
      if (bucket !== '') {
        // Ensure bucket cache directory
        const bucketCacheDirectory = path.join(self.cacheDirectory, bucket);
        fs.mkdir(bucketCacheDirectory, '0755', function(err) {
          if (err && err.code !== 'EEXIST') {
            done(new Error('Could not create cache directory ' + bucketCacheDirectory + ' ' + err.message));
          } else {
            done(null, false);
          }
        });
      } else {
        done(null, false);
      }
    } else if (err) {
      done(new Error('Could not stat ' + filename + ' ' + err.message));
    } else if (!err && stats && stats.isFile() && stats.size > 0 && stats.mtime.getTime() > Date.now()) {
      // Cache hit
      done(null, true, stats.atime, stats.mtime);
    } else {
      // Cache expired/invalid
      done(null, false);
    }
  });
};

Petra.prototype.fetchFromPeer = function(bucket, fingerprint, filename, done) {
  if (this.hashring) {
    const peer = this.hashring.get(fingerprint);
    if (peer === this.whoami) {
      // Fingerprint is mine
      done(null, false);
    } else {
      // Fetch from peer
      const peerPath = '/' + (bucket.length !== 0 ? bucket + '/' : '') + fingerprint;
      const peerUrl = 'http://' + peer + ':' + this.port + peerPath;
      this.fetchFromUpstream(peerUrl, bucket, fingerprint, filename, function(err, hit, atime, mtime) {
        if (err) {
          // Not found on peer
          done(null, false);
        } else {
          done(null, hit, atime, mtime);
        }
      });
    }
  } else {
    // No hash ring configured
    done(null, false);
  }
};

Petra.prototype.fetchFromUpstream = function(upstreamUrl, bucket, fingerprint, filename, done) {
  const self = this;
  const partialFilename = filename + '.part';
  const upstream = request({
    uri: upstreamUrl,
    timeout: 10000
  });
  let upstreamStatus = 504;  // Gateway Timeout
  upstream.on('response', function(response) {
    upstreamStatus = parseInt(response.statusCode, 10);
    if (upstreamStatus === 200) {
      if (self.mediaTypes.length > 0 && self.mediaTypes.indexOf(response.headers['content-type']) === -1) {
        // Unsupported Content-Type header from upstream
        done(new Error('Upstream ' + upstreamUrl + ' responded with unsupported content-type ' + response.headers['content-type']));
      } else {
        // Upstream ready to pipe data from
        response.pause();
        // Create input file and listen for finish event
        const file = fs.createWriteStream(partialFilename);
        file.on('finish', function() {
          if (upstreamStatus === 200) {
            // Rename completed file
            fs.rename(partialFilename, filename, function(err) {
              if (err) {
                done(new Error('Could not rename ' + partialFilename + ' as ' + filename + ' ' + err.message));
              } else {
                // Time-to-live is maximum of (Cache-Control header, configured TTL) in seconds
                const ttl = Math.max(self.minimumTtl, ttlFromCacheControlHeader(response.headers['cache-control']));
                // Set file m(odified)time to its expiry time
                const atime = new Date();
                const mtime = new Date(Date.now() + ttl * 1000);
                fs.utimes(filename, atime, mtime, function(err) {
                  if (err) {
                    done(new Error('Could not utimes ' + filename + ' ' + err.message));
                  } else {
                    // Success
                    done(null, true, atime, mtime);
                    // Notify hash ring of new content
                    self.notify(bucket, fingerprint);
                  }
                });
              }
            });
          } else {
            done(new Error('Upstream ' + upstreamUrl + ' responded with status code ' + upstreamStatus));
          }
        });
        // Pipe HTTP response to local file
        response.pipe(file);
        response.resume();
      }
    } else {
      // Abort non-200 upstream reponses
      upstream.abort();
      done(new Error('Upstream ' + upstreamUrl + ' responded with status code ' + upstreamStatus));
    }
  }).on('error', function(err) {
    // Upstream request failed, most likely timeout
    fs.unlink(partialFilename, function() {
      done(new Error('Upstream ' + upstreamUrl + ' failed ' + err.message));
    });
  });
};

Petra.prototype.notify = function(bucket, fingerprint) {
  const self = this;
  const peer = this.hashring.get(fingerprint);
  if (peer !== this.whoami) {
    process.nextTick(function() {
      request.post({
        uri: 'http://' + peer + ':' + self.port + '/notify',
        form: {
          bucket: bucket,
          fingerprint: fingerprint
        },
        timeout: 5000
      }, function(err, res) {
        if (err) {
          self.log('Notification peer:' + peer + ' fingerprint:' + fingerprint + ' error:' + err.message);
        } else if (res.statusCode !== 200) {
          self.log('Notification peer:' + peer + ' fingerprint:' + fingerprint + ' code:' + res.statusCode);
        }
      });
    });
  }
};

Petra.prototype.serve = function(req, res) {
  const self = this;
  if (this.hashring.has(req.connection.remoteAddress)) {
    if (req.method === 'POST' && req.url === '/notify') {
      // Notification of new cached content
      let body = '';
      req.on('data', function (data) {
        body = body + data;
      });
      req.on('end', function(){
        // OK
        res.writeHead(200);
        res.end();
        // Generate local filename from params
        const params = querystring.parse(body);
        const filename = self.cacheFilePath(params.bucket, params.fingerprint);
        fs.stat(filename, function(err, stats) {
          if (err && err.code === 'ENOENT') {
            // Not on local filesystem, request from peer that notified us
            const peerPath = '/' + (params.bucket.length !== 0 ? params.bucket + '/' : '') + params.fingerprint;
            const peerUrl = 'http://' + req.connection.remoteAddress + ':' + self.port + peerPath;
            locker.lock(filename, function() {
              self.fetchFromUpstream(peerUrl, params.bucket, params.fingerprint, filename, function(err) {
                locker.unlock(filename);
                if (err) {
                  self.log('Could not fetch from peer ' + peerUrl + ' ' + err.message);
                }
              });
            });
          }
        });
      });
    } else if (req.method === 'GET') {
      // Request for cached content
      const done = finalhandler(req, res, {
        onerror: this.log
      });
      this.serveStatic(req, res, done);
    }
  } else {
    // Unknown remote address
    this.log('Rejected notify request from ' + req.connection.remoteAddress);
    res.writeHead(404);
    res.write('Not Found');
    res.end();
  }
};

Petra.prototype.purgeCache = function(directory) {
  const self = this;
  fs.readdir(directory, function(err, files) {
    if (!err) {
      files.forEach(function(file) {
        const filePath = path.join(directory, file);
        fs.stat(filePath, function(err, stats) {
          if (!err && stats && stats.isDirectory()) {
            // Recurse into directory
            self.purgeCache(filePath);
          } else if (stats && stats.isFile() && stats.mtime.getTime() < Date.now()) {
            // Remove stale file
            locker.lock(filePath, function() {
              fs.unlink(filePath, function() {
                locker.unlock(filePath);
              });
            });
          }
        });
      });
    }
  });
};
