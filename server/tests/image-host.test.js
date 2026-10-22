'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMaterialImageUrls } = require('../src/services/image-host');

test('derives card image and list thumb from EasyImage upload path', () => {
  const sized = buildMaterialImageUrls('https://img2.matishare.com/i/1/2026/10/22/skd92f-1.jpg');
  assert.deepEqual(sized, {
    url: 'https://img2.matishare.com/app/thumb.php?img=/i/1/2026/10/22/skd92f-1.jpg&w=1080&q=82',
    thumbUrl: 'https://img2.matishare.com/app/thumb.php?img=/i/1/2026/10/22/skd92f-1.jpg&w=258&h=344&q=80',
  });
});

test('returns null when the URL is not an EasyImage upload path', () => {
  assert.equal(buildMaterialImageUrls('https://example.com/photo.jpg'), null);
  assert.equal(buildMaterialImageUrls('/i/1/2026/10/22/skd92f-1.jpg'), null);
  assert.equal(buildMaterialImageUrls(''), null);
});
