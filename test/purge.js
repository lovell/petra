'use strict';

import fs from 'fs';

import mockFs from 'mock-fs';
import ava from 'ava';

import Petra from '../';

// Test data
const content = new Buffer('test-image-content');
const cacheDirectory = '/tmp/petra';
const purgeStaleInterval = 1;

ava.cb.serial('purge all stale content from cache', t => {
  t.plan(2);

  const keepMeFilename = cacheDirectory + '/ke/keep-me';
  const purgeMeFilename = cacheDirectory + '/pu/purge-me';

  mockFs({
    [keepMeFilename]: mockFs.file({
      content,
      atime: new Date(),
      mtime: new Date(Date.now() + 3000)
    }),
    [purgeMeFilename]: mockFs.file({
      content,
      atime: new Date(1),
      mtime: new Date(1)
    })
  });

  // Create cache with 1s purge interval
  const petra = new Petra({ // eslint-disable-line no-unused-vars
    cacheDirectory,
    purgeStaleInterval
  });

  // Wait 2s before verifying
  setTimeout(function () {
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
  }, 2000);
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
