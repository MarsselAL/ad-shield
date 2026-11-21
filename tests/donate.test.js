/*
 * src/shared/donate.js: the support values the popup and the settings page show. Values match
 * docs/donate.txt (checked by tests/test_package.py).
 */
loadSrc('src/config.js', 'src/shared/donate.js');

test('donate: Revolut link is a plain https link', function () {
  var d = __TAS__.donate;
  assert.ok(/^https:\/\/revolut\.me\/[A-Za-z0-9._-]+$/.test(d.url), 'revolut link');
});

test('donate: USDC address is a 0x + 40 hex Ethereum address', function () {
  var d = __TAS__.donate;
  assert.ok(/^0x[0-9a-fA-F]{40}$/.test(d.usdcErc20), 'address');
});

test('donate: BTC address is a lowercase bech32 bc1q address', function () {
  var d = __TAS__.donate;
  assert.ok(/^bc1q[02-9ac-hj-np-z]{38}(?:[02-9ac-hj-np-z]{20})?$/.test(d.btc), 'address ' + d.btc);
});

test('donate: BTC warning names Bitcoin network only', function () {
  assert.equal(__TAS__.donate.btcNote, 'BTC on the Bitcoin network only — other coins or networks will be lost');
});

test('donate: network warning names USDC, Ethereum and ERC-20', function () {
  var note = __TAS__.donate.usdcNote;
  assert.includes(note, 'USDC');
  assert.includes(note, 'Ethereum');
  assert.includes(note, 'ERC-20');
  assert.includes(note, 'lost');
});

test('donate: values are frozen', function () {
  var d = __TAS__.donate;
  assert.ok(Object.isFrozen(d), 'frozen');
});
