'use strict';

import fs from 'fs';

import mockFs from 'mock-fs';
import nock from 'nock';
import ava from 'ava';

import Petra from '../';

// Test data
const host = 'http://example.com';
const path = '/path';
const url = host + path;
const fingerprint = 'test-fingerprint';
const cacheDirectory = '/tmp/petra';
const cacheFilename = cacheDirectory + '/te/' + fingerprint;
const content = Buffer.from('test-image-content');
const hash = function () {
  return fingerprint;
};

ava.serial.cb('successful fetch from upstream', t => {
  t.plan(6);

  mockFs({});
  const upstream = nock(host, { reqheaders: { 'user-agent': 'lovell/petra' } })
    .get(path)
    .reply(200, content);
  const petra = new Petra({
    cacheDirectory,
    hash
  });

  petra.fetch(url, (err, filename, atime, mtime) => {
    // Verify no error
    t.falsy(err);
    // Verify filename
    t.is(filename, cacheFilename);
    // Verify file contents
    t.is(0, Buffer.compare(content, fs.readFileSync(filename)));
    // Verify dates
    t.true(atime instanceof Date);
    t.true(mtime instanceof Date);
    // Verify upstream request occurred
    t.true(upstream.isDone());
    // Cleanup
    mockFs.restore();
    t.end();
  });
});

ava.serial.cb('successful fetch from filesystem', t => {
  t.plan(6);

  const atime = new Date();
  const mtime = new Date(Date.now() + 10000);

  mockFs({
    [cacheFilename]: mockFs.file({
      content,
      atime,
      mtime
    })
  });
  const upstream = nock(host)
    .get(path)
    .reply(200, content);
  const petra = new Petra({
    cacheDirectory,
    hash
  });

  petra.fetch(url, (err, filename, actualAtime, actualMtime) => {
    // Verify no error
    t.falsy(err);
    // Verify filename
    t.is(filename, cacheFilename);
    // Verify file contents
    t.is(0, Buffer.compare(content, fs.readFileSync(filename)));
    // Verify dates
    t.is(atime.toISOString(), actualAtime.toISOString());
    t.is(mtime.toISOString(), actualMtime.toISOString());
    // Verify upstream request did not occur
    t.false(upstream.isDone());
    // Cleanup
    mockFs.restore();
    nock.cleanAll();
    t.end();
  });
});

ava.serial.cb('successful fetch from upstream due to expired cache', t => {
  t.plan(6);

  mockFs({
    [cacheFilename]: mockFs.file({
      content,
      atime: new Date(1),
      mtime: new Date(1)
    })
  });
  const upstream = nock(host)
    .get(path)
    .reply(200, content);
  const petra = new Petra({
    cacheDirectory,
    hash
  });

  petra.fetch(url, (err, filename, atime, mtime) => {
    // Verify no error
    t.falsy(err);
    // Verify filename
    t.is(filename, cacheFilename);
    // Verify file contents
    t.is(0, Buffer.compare(content, fs.readFileSync(filename)));
    // Verify dates
    t.true(atime instanceof Date);
    t.true(mtime instanceof Date);
    // Verify upstream request did not occur
    t.true(upstream.isDone());
    // Cleanup
    mockFs.restore();
    t.end();
  });
});

ava.serial.cb('failed fetch from upstream due to 404', t => {
  t.plan(4);

  mockFs({});
  const upstream = nock(host)
    .get(path)
    .reply(404);
  const petra = new Petra({
    cacheDirectory,
    hash
  });

  petra.fetch(url, (err) => {
    // Verify error
    t.true(err instanceof Error);
    t.is(err.message, 'Upstream http://example.com/path failed: status code 404');
    t.is(err.code, 404);
    // Verify upstream request occurred
    t.true(upstream.isDone());
    // Cleanup
    mockFs.restore();
    t.end();
  });
});

ava.serial.cb('failed fetch from upstream due to 500', t => {
  t.plan(4);

  mockFs({});
  const upstream = nock(host)
    .get(path)
    .reply(500);
  const petra = new Petra({
    cacheDirectory,
    hash
  });

  petra.fetch(url, (err) => {
    // Verify error
    t.true(err instanceof Error);
    t.is(err.message, 'Upstream http://example.com/path failed: status code 500');
    t.is(err.code, 500);
    // Verify upstream request occurred
    t.true(upstream.isDone());
    // Cleanup
    mockFs.restore();
    t.end();
  });
});

ava.serial.cb('failed fetch from upstream with named error code', t => {
  t.plan(4);

  mockFs({});
  const upstream = nock(host)
    .get(path)
    .replyWithError({ message: 'test error', code: 'ETEST' });
  const petra = new Petra({
    cacheDirectory,
    hash
  });

  petra.fetch(url, (err) => {
    // Verify error
    t.true(err instanceof Error);
    t.is(err.message, 'Upstream http://example.com/path failed: test error');
    t.is(err.code, 502);
    // Verify upstream request occurred
    t.true(upstream.isDone());
    // Cleanup
    mockFs.restore();
    t.end();
  });
});

ava.serial.cb('failed fetch from upstream due to socket timeout', t => {
  t.plan(3);

  const url = 'http://127.0.0.1:50000/path';
  mockFs({});
  const petra = new Petra({
    cacheDirectory,
    hash,
    requestTimeout: 100
  });

  petra.fetch(url, (err) => {
    // Verify error
    t.true(err instanceof Error);
    t.is(err.message, 'Upstream http://127.0.0.1:50000/path failed: connect ECONNREFUSED 127.0.0.1:50000');
    t.is(err.code, 504);
    // Cleanup
    mockFs.restore();
    t.end();
  });
});

ava.serial.cb('failed fetch from upstream due to download time > response timeout', t => {
  t.plan(4);

  mockFs({});
  const upstream = nock(host)
    .get(path)
    .delayBody(200)
    .reply(200, content);
  const petra = new Petra({
    cacheDirectory,
    hash,
    responseTimeout: 100
  });

  petra.fetch(url, err => {
    // Verify error
    t.true(err instanceof Error);
    t.is(err.message, 'Upstream http://example.com/path failed: response timeout of 100ms');
    t.is(err.code, 504);
    // Verify upstream request occurred
    t.true(upstream.isDone());
    // Cleanup
    mockFs.restore();
    t.end();
  });
});

ava.serial.cb('Concurrent fetch for same URL result in 1 upstream', t => {
  const concurrency = 20;
  t.plan(concurrency * 6);

  mockFs({});
  const upstream = nock(host)
    .get(path)
    .reply(200, content);
  const petra = new Petra({
    cacheDirectory,
    hash
  });

  let remaining = concurrency;
  const test = function () {
    petra.fetch(url, (err, filename, atime, mtime) => {
      // Verify no error
      t.falsy(err);
      // Verify filename
      t.is(filename, cacheFilename);
      // Verify file contents
      t.is(0, Buffer.compare(content, fs.readFileSync(filename)));
      // Verify dates
      t.true(atime instanceof Date);
      t.true(mtime instanceof Date);
      // Verify upstream request occurred
      t.true(upstream.isDone());
      // Cleanup, if last
      remaining--;
      if (remaining === 0) {
        mockFs.restore();
        t.end();
      }
    });
  };
  // Run
  [...Array(concurrency).keys()].forEach(test);
});

ava.serial.cb('use default sha256 hash function', t => {
  t.plan(6);
  const expectedCachePath = '/7d/7db5de67837e9b1d9b64416db779f447851c711519ad6985bc2d63207577cca0';

  mockFs({});
  const upstream = nock(host)
    .get(path)
    .reply(200, content);
  const petra = new Petra({
    cacheDirectory
  });

  petra.fetch(url, (err, filename, atime, mtime) => {
    // Verify no error
    t.falsy(err);
    // Verify filename
    t.is(filename, cacheDirectory + expectedCachePath);
    // Verify file contents
    t.is(0, Buffer.compare(content, fs.readFileSync(filename)));
    // Verify dates
    t.true(atime instanceof Date);
    t.true(mtime instanceof Date);
    // Verify upstream request occurred
    t.true(upstream.isDone());
    // Cleanup
    mockFs.restore();
    t.end();
  });
});

ava.serial.cb('accepted media-type from upstream', t => {
  t.plan(6);

  const acceptedMediaType = 'test/ok';

  mockFs({});
  const upstream = nock(host)
    .get(path)
    .reply(200, content, {
      'content-type': acceptedMediaType
    });
  const petra = new Petra({
    cacheDirectory,
    hash,
    mediaTypes: [ acceptedMediaType ]
  });

  petra.fetch(url, (err, filename, atime, mtime) => {
    // Verify no error
    t.falsy(err);
    // Verify filename
    t.is(filename, cacheFilename);
    // Verify file contents
    t.is(0, Buffer.compare(content, fs.readFileSync(filename)));
    // Verify dates
    t.true(atime instanceof Date);
    t.true(mtime instanceof Date);
    // Verify upstream request occurred
    t.true(upstream.isDone());
    // Cleanup
    mockFs.restore();
    t.end();
  });
});

ava.serial.cb('unaccepted media-type from upstream', t => {
  t.plan(4);

  const acceptedMediaType = 'test/ok';
  const unacceptedMediaType = 'test/fail';

  mockFs({});
  const upstream = nock(host)
    .get(path)
    .reply(200, content, {
      'content-type': unacceptedMediaType
    });
  const petra = new Petra({
    cacheDirectory,
    hash,
    mediaTypes: [ acceptedMediaType ]
  });

  petra.fetch(url, (err, filename, atime, mtime) => {
    // Verify error
    t.true(err instanceof Error);
    t.is(err.message, 'Upstream http://example.com/path failed: unsupported media-type test/fail');
    t.is(err.code, 415);
    // Verify upstream request occurred
    t.true(upstream.isDone());
    // Cleanup
    mockFs.restore();
    t.end();
  });
});

ava.serial.cb('upstream responds with "cache-control: private", use min TTL', t => {
  t.plan(5);

  const minimumTtl = 10;

  mockFs({});
  const upstream = nock(host)
    .get(path)
    .reply(200, content, {
      'cache-control': 'private'
    });
  const petra = new Petra({
    cacheDirectory,
    hash,
    minimumTtl
  });

  petra.fetch(url, (err, filename, atime, mtime) => {
    // Verify no error
    t.falsy(err);
    // Verify filename
    t.is(filename, cacheFilename);
    // Verify file contents
    t.is(0, Buffer.compare(content, fs.readFileSync(filename)));
    // Verify expiry in minimumTtl seconds
    t.is(atime.getTime() + minimumTtl * 1000, mtime.getTime());
    // Verify upstream request occurred
    t.true(upstream.isDone());
    // Cleanup
    mockFs.restore();
    t.end();
  });
});

ava.serial.cb('upstream responds with "cache-control: no-cache", use min TTL', t => {
  t.plan(5);

  const minimumTtl = 10;

  mockFs({});
  const upstream = nock(host)
    .get(path)
    .reply(200, content, {
      'cache-control': 'no-cache'
    });
  const petra = new Petra({
    cacheDirectory,
    hash,
    minimumTtl
  });

  petra.fetch(url, (err, filename, atime, mtime) => {
    // Verify no error
    t.falsy(err);
    // Verify filename
    t.is(filename, cacheFilename);
    // Verify file contents
    t.is(0, Buffer.compare(content, fs.readFileSync(filename)));
    // Verify expiry in minimumTtl seconds
    t.is(atime.getTime() + minimumTtl * 1000, mtime.getTime());
    // Verify upstream request occurred
    t.true(upstream.isDone());
    // Cleanup
    mockFs.restore();
    t.end();
  });
});

ava.serial.cb('upstream responds with "cache-control: unknown", use min TTL', t => {
  t.plan(5);

  const minimumTtl = 10;

  mockFs({});
  const upstream = nock(host)
    .get(path)
    .reply(200, content, {
      'cache-control': 'unknown'
    });
  const petra = new Petra({
    cacheDirectory,
    hash,
    minimumTtl
  });

  petra.fetch(url, (err, filename, atime, mtime) => {
    // Verify no error
    t.falsy(err);
    // Verify filename
    t.is(filename, cacheFilename);
    // Verify file contents
    t.is(0, Buffer.compare(content, fs.readFileSync(filename)));
    // Verify expiry in minimumTtl seconds
    t.is(atime.getTime() + minimumTtl * 1000, mtime.getTime());
    // Verify upstream request occurred
    t.true(upstream.isDone());
    // Cleanup
    mockFs.restore();
    t.end();
  });
});

ava.serial.cb('upstream responds with "cache-control: max-age=2"', t => {
  t.plan(5);

  const minimumTtl = 1;

  mockFs({});
  const upstream = nock(host)
    .get(path)
    .reply(200, content, {
      'cache-control': 'max-age=2'
    });
  const petra = new Petra({
    cacheDirectory,
    hash,
    minimumTtl
  });

  petra.fetch(url, (err, filename, atime, mtime) => {
    // Verify no error
    t.falsy(err);
    // Verify filename
    t.is(filename, cacheFilename);
    // Verify file contents
    t.is(0, Buffer.compare(content, fs.readFileSync(filename)));
    // Verify expiry in 2s
    t.is(atime.getTime() + 2000, mtime.getTime());
    // Verify upstream request occurred
    t.true(upstream.isDone());
    // Cleanup
    mockFs.restore();
    t.end();
  });
});

ava.serial.cb('upstream responds with "cache-control: s-maxage=2"', t => {
  t.plan(5);

  const minimumTtl = 1;

  mockFs({});
  const upstream = nock(host)
    .get(path)
    .reply(200, content, {
      'cache-control': 's-maxage=2'
    });
  const petra = new Petra({
    cacheDirectory,
    hash,
    minimumTtl
  });

  petra.fetch(url, (err, filename, atime, mtime) => {
    // Verify no error
    t.falsy(err);
    // Verify filename
    t.is(filename, cacheFilename);
    // Verify file contents
    t.is(0, Buffer.compare(content, fs.readFileSync(filename)));
    // Verify expiry in 2s
    t.is(atime.getTime() + 2000, mtime.getTime());
    // Verify upstream request occurred
    t.true(upstream.isDone());
    // Cleanup
    mockFs.restore();
    t.end();
  });
});
