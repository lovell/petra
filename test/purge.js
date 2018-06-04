'use strict';

import fs from 'fs';
import childProcess from 'child_process';
import EventEmitter from 'events';

import mockFs from 'mock-fs';
import sinon from 'sinon';
import ava from 'ava';

import Petra from '../';

// Test data
const content = Buffer.from('test-image-content');
const cacheDirectory = '/tmp/petra';
const purgeStaleInterval = 1;

ava.cb.serial('purge all stale content from cache', t => {
  t.plan(3);

  const keepMeFilename = cacheDirectory + '/ke/keep-me';
  const purgeMe1Filename = cacheDirectory + '/pu/purge-me-1';
  const purgeMe2Filename = cacheDirectory + '/pu/purge-me-2';

  mockFs({
    [keepMeFilename]: mockFs.file({
      content,
      atime: new Date(),
      mtime: new Date(Date.now() + 3000)
    }),
    [purgeMe1Filename]: mockFs.file({
      content,
      atime: new Date(1),
      mtime: new Date(1)
    }),
    [purgeMe2Filename]: mockFs.file({
      content,
      atime: new Date(1),
      mtime: new Date(1)
    })
  });

  const noop = () => {};
  const staleFileEmitter = new EventEmitter();
  const spawnStub = sinon
    .stub(childProcess, 'spawn')
    .returns({ on: noop, stdout: staleFileEmitter });

  // Create cache with 1s purge interval
  const petra = new Petra({ // eslint-disable-line no-unused-vars
    cacheDirectory,
    purgeStaleInterval
  });

  // Wait 2s before emitting stale purge-me-1 event
  setTimeout(function () {
    staleFileEmitter.emit('data', purgeMe1Filename);
  }, 2000);

  // Wait 3s before emitting stale purge-me-2 event
  setTimeout(function () {
    staleFileEmitter.emit('data', purgeMe2Filename);
  }, 3000);

  // Wait 4s before verifying
  setTimeout(function () {
    // Verify keep-me was kept
    t.notThrows(function () {
      fs.accessSync(keepMeFilename, fs.constants.F_OK);
    });
    // Verify purge-me-1 was purged
    t.throws(function () {
      fs.accessSync(purgeMe1Filename, fs.constants.F_OK);
    });
    // Verify purge-me-2 was purged
    t.throws(function () {
      fs.accessSync(purgeMe2Filename, fs.constants.F_OK);
    });
    // Cleanup
    mockFs.restore();
    spawnStub.restore();
    t.end();
  }, 4000);
});

ava.cb.serial('purge one item from cache', t => {
  t.plan(3);

  const keepMeFilename = cacheDirectory + '/ke/keep-me';
  const purgeMeFilename = cacheDirectory + '/pu/purge-me';

  mockFs({
    [keepMeFilename]: content,
    [purgeMeFilename]: content
  });
  const petra = new Petra({
    cacheDirectory,
    hash: function (url) {
      return (url === 'purge') ? 'purge-me' : 'keep-me';
    }
  });

  petra.purge('purge', (err) => {
    // Verify no error
    t.ifError(err);
    // Verify keep-me was kept
    t.notThrows(function () {
      fs.accessSync(keepMeFilename, fs.constants.F_OK);
    });
    // Verify purge-me was purged
    t.throws(function () {
      fs.accessSync(purgeMeFilename, fs.constants.F_OK);
    });
    // Cleanup
    mockFs.restore();
    t.end();
  });
});

ava.cb.serial('purge non-existent item from cache', t => {
  t.plan(1);

  mockFs({});
  const petra = new Petra({
    cacheDirectory
  });

  petra.purge('purge', (err) => {
    // Verify no error
    t.ifError(err);
    // Cleanup
    mockFs.restore();
    t.end();
  });
});
