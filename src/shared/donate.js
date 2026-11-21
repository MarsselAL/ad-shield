/*
 * Support Ad Shield: the public tip link and the USDC and BTC addresses shown in the popup footer and on the
 * settings page. Same values as docs/donate.txt (used by tools/build.py for the shared builds);
 * tests/test_package.py fails when the two differ. Nothing here is fetched or sent anywhere.
 */
(function (root) {
  'use strict';
  var ns = root.__TAS__ = root.__TAS__ || {};
  ns.donate = Object.freeze({
    url: 'https://revolut.me/marsel951u',
    usdcErc20: '0xD26B379f952D9a3008eB5a8C908d335F5715b18A',
    usdcNote: 'USDC on Ethereum (ERC-20) only — other coins or networks will be lost',
    btc: 'bc1q37wpzj5zdfnpj7xa0vzwjyy6nep7fnf3s02cns',
    btcNote: 'BTC on the Bitcoin network only — other coins or networks will be lost'
  });
})(globalThis);
