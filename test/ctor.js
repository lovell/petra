'use strict';

import mockFs from 'mock-fs';
import ava from 'ava';

import Petra from '../';

// Test data
const cacheDirectory = '/tmp/petra';

ava.serial('read-only filesystem fails', t => {
  t.plan(1);
  mockFs({
    [cacheDirectory]: mockFs.directory({
      mode: parseInt('0444', 8)
    })
  });

  t.throws(function () {
    const petra = new Petra({ // eslint-disable-line no-unused-vars
      cacheDirectory
    });
  });

  // Cleanup
  mockFs.restore();
});

ava.serial('default options', t => {
  t.plan(1);
  mockFs({});

  t.notThrows(function () {
    const petra = new Petra(); // eslint-disable-line no-unused-vars
  });

  // Cleanup
  mockFs.restore();
});

ava.serial('enable debug', t => {
  t.plan(1);
  mockFs({});

  const petra = new Petra({
    debug: true,
    log: function (msg) {
      t.pass();
    }
  });
  petra.debug();

  // Cleanup
  mockFs.restore();
});
