/* Runs the registered tests, drains the promise queue, prints a summary, fails the process on error. */
__runAll();
drainMicrotasks();
if (__results.passed + __results.failed !== __tests.length) {
  print('RESULT INCOMPLETE ' + (__results.passed + __results.failed) + '/' + __tests.length + ' finished (a test never settled)');
  throw new Error('incomplete');
}
if (__results.failed) {
  print('RESULT FAIL ' + __results.failed + ' failed, ' + __results.passed + ' passed');
  throw new Error('test failures');
}
print('RESULT OK ' + __results.passed + ' passed');
