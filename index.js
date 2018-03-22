'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const got = require('got');

// Parse TTL from a Cache-Control response header, in seconds, defaulting to 0
const ttlFromCacheControlHeader = function (cacheControlHeader) {
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
const FileLocker = function () {
  this.lockedFiles = new Map();
};
const locker = new FileLocker();

FileLocker.prototype.lock = function (file, proceed) {
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

FileLocker.prototype.unlock = function (file) {
  if (this.lockedFiles.has(file)) {
    if (this.lockedFiles.get(file).onRelease.length > 0) {
      // Transfer lock
      this.lockedFiles.get(file).lastUpdated = Date.now();
      this.lockedFiles.get(file).onRelease.shift()();
    } else {
      // Remove empty lock
      this.lockedFiles.delete(file);
    }
  }
};

const sha256 = function (str) {
  const sha256 = crypto.createHash('sha256');
  sha256.update(str);
  return sha256.digest('hex');
};

const noop = () => {};

const purgeStale = function (directory) {
  childProcess.spawn('find', [`"${directory}"`, '-type', 'f', '-mtime', '+1', '-print'], {
    stdio: ['ignore', 'pipe', 'ignore']
  }).stdout.on('data', function (staleFilePath) {
    // Remove stale file
    locker.lock(staleFilePath, function () {
      fs.unlink(staleFilePath, function () {
        locker.unlock(staleFilePath);
      });
    });
  });
};

const isNumberOrDefault = (val, def) => typeof val === 'number' ? val : def;

// Petra object

const Petra = function (options) {
  // Parse options
  options = options || {};
  this.minimumTtl = isNumberOrDefault(options.minimumTtl, 7 * 24 * 60 * 60); // 7 days, in seconds
  this.purgeStaleInterval = isNumberOrDefault(options.purgeStaleInterval, 60 * 60); // 1 hour, in seconds
  this.mediaTypes = options.mediaTypes || [];
  this.log = options.log || console.log;
  this.debug = options.debug ? this.log : noop;
  this.requestTimeout = isNumberOrDefault(options.requestTimeout, 10000); // 10 seconds
  this.responseTimeout = isNumberOrDefault(options.responseTimeout, 10000); // 10 seconds
  this.retries = isNumberOrDefault(options.retries, 0);
  this.userAgent = options.userAgent || 'lovell/petra';
  // Ensure cache directory exists and has read-write access
  this.cacheDirectory = options.cacheDirectory || path.join(os.tmpdir(), 'petra');
  try {
    fs.mkdirSync(this.cacheDirectory, '0755');
  } catch (err) {}
  fs.accessSync(this.cacheDirectory, fs.constants.R_OK | fs.constants.W_OK);
  // Hash function, default to sha256
  this.hash = (typeof options.hash === 'function') ? options.hash : sha256;
  // Start purge cache task
  this.purgeStaleTask = setInterval(() => {
    purgeStale(this.cacheDirectory);
  }, this.purgeStaleInterval * 1000);
};
module.exports = Petra;

Petra.prototype._cachePath = function (fingerprint) {
  return path.join(this.cacheDirectory, fingerprint.substr(0, 2));
};

Petra.prototype.fetch = function (url, done) {
  // Fingerprint and filename
  const fingerprint = this.hash(url);
  const cachePath = this._cachePath(fingerprint);
  const filename = path.join(cachePath, fingerprint);
  // Lock
  locker.lock(filename, () => {
    // Check local filesystem
    this._fetchFromFilesystem(cachePath, filename, (err, atime, mtime) => {
      if (!err && atime && mtime) {
        // Filesystem hit
        this.debug(`Filesystem hit ${filename}`);
        locker.unlock(filename);
        done(null, filename, atime, mtime);
      } else {
        // Filesystem miss
        this.debug(`Filesystem miss ${filename}`);
        // Check upstream
        this._fetchFromUpstream(url, filename, (err, atime, mtime) => {
          if (err) {
            // Upstream error
            this.debug(err.message);
            done(err);
            locker.unlock(filename);
          } else {
            // Upstream OK
            this.debug(`Upstream OK ${url}`);
            locker.unlock(filename);
            done(null, filename, atime, mtime);
          }
        });
      }
    });
  });
};

Petra.prototype._fetchFromFilesystem = function (cachePath, filename, done) {
  fs.stat(filename, (err, stats) => {
    if (err && err.code === 'ENOENT') {
      // Ensure cachePath directory exists
      fs.mkdir(cachePath, '0755', (err) => {
        if (err && err.code !== 'EEXIST') {
          this.log(`Could not mkdir ${cachePath} ${err.code}`);
        }
        done(null);
      });
    } else if (err) {
      this.log(`Could not stat ${filename} ${err.code}`);
      done(null);
    } else if (!err && stats && stats.isFile() && stats.size > 0 && stats.mtime.getTime() > Date.now()) {
      // Cache hit
      done(null, stats.atime, stats.mtime);
    } else {
      // Cache expired/invalid
      this.debug(`Cached file ${filename} expired`);
      done(null);
    }
  });
};

Petra.prototype._fetchFromUpstream = function (url, filename, done) {
  const partialContentFilename = `${filename}.part`;
  const upstream = got.stream(url, {
    timeout: this.requestTimeout,
    retries: this.retries,
    headers: {
      'user-agent': this.userAgent
    }
  });
  if (this.responseTimeout > 0) {
    upstream.once('request', (request) => {
      const abortTimeoutId = setTimeout(() => {
        request.abort();
        upstream.emit('error', new Error('Response timeout'));
      }, this.responseTimeout);
      upstream.on('close', () => clearTimeout(abortTimeoutId));
    });
  }
  upstream.once('response', (response) => {
    if (this.mediaTypes.length > 0 && this.mediaTypes.indexOf(response.headers['content-type']) === -1) {
      // Unsupported Content-Type header from upstream
      upstream.emit('error', new Error(`Unsupported media-type ${response.headers['content-type']}`));
    } else {
      // Upstream ready to pipe data from
      upstream.pause();
      // Create input file and listen for finish event
      const file = fs.createWriteStream(partialContentFilename);
      file.on('close', () => {
        // Rename completed file
        fs.rename(partialContentFilename, filename, (err) => {
          if (err) {
            done(new Error(`Could not rename ${partialContentFilename} as ${filename} ${err.code}`));
          } else {
            // Time-to-live is maximum of (Cache-Control header, configured TTL) in seconds
            const ttl = Math.max(this.minimumTtl, ttlFromCacheControlHeader(response.headers['cache-control']));
            // Set file m(odified)time to its expiry time
            const atime = new Date();
            const mtime = new Date(atime.getTime() + ttl * 1000);
            fs.utimes(filename, atime, mtime, (err) => {
              if (err) {
                done(new Error(`Could not update ${filename} ${err.code}`));
              } else {
                // Success
                done(null, atime, mtime);
              }
            });
          }
        });
      });
      // Pipe HTTP response to local file
      upstream.pipe(file);
      upstream.resume();
    }
  }).once('error', (err) => {
    fs.unlink(partialContentFilename, () => {
      done(new Error(`Upstream ${url} failed: ${err.code || err.message}`));
    });
  }).on('error', () => {});
};

Petra.prototype.purge = function (url, done) {
  // Fingerprint and filename
  const fingerprint = this.hash(url);
  const cachePath = this._cachePath(fingerprint);
  const filename = path.join(cachePath, fingerprint);
  // Lock
  locker.lock(filename, () => {
    fs.unlink(filename, () => {
      locker.unlock(filename);
      done();
    });
  });
};
