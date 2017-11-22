//  Generic Lambda Function for loading and starting a sigfox-aws module from NPM.

/* eslint-disable max-len, camelcase, no-console, no-nested-ternary, import/no-dynamic-require, import/newline-after-import, import/no-unresolved, global-require */
process.on('uncaughtException', err => console.error('uncaughtException', err.message, err.stack));  //  Display uncaught exceptions.
process.on('unhandledRejection', (reason, p) => console.error('Unhandled Rejection at:', p, 'reason:', reason));

//  //////////////////////////////////////////////////////////////////////////////////// endregion
//  region AutoInstall: List all dependencies here, or just paste the contents of package.json. Autoinstall will install these dependencies.

if (!process.env.AUTOINSTALL_DEPENDENCY) throw new Error('Environment variable AUTOINSTALL_DEPENDENCY must be defined');
if (!process.env.AUTOINSTALL_VERSION) throw new Error('Environment variable AUTOINSTALL_VERSION must be defined');
const dependency = process.env.AUTOINSTALL_DEPENDENCY.trim();
const version = process.env.AUTOINSTALL_VERSION.trim();

const package_json = {
  dependencies: {
    [dependency]: version,
  },
}; /* eslint-enable quote-props,quotes,comma-dangle,indent */

//  //////////////////////////////////////////////////////////////////////////////////// endregion
//  region AWS Lambda Startup

// eslint-disable-next-line arrow-body-style
exports.handler = (event, context, callback) => {
  //  Don't allow AWS to wait for event loop to be empty, quit immediately when
  //  callback function is called.  Also allows the wrapped function to be reused.
  // eslint-disable-next-line no-param-reassign
  context.callbackWaitsForEmptyEventLoop = false;
  console.log(JSON.stringify({ event, env: process.env }, null, 2));

  //  Install the dependencies from package_json above.  Will reload the script.
  //  eslint-disable-next-line no-use-before-define
  return autoInstall(package_json, event, context, callback)
    .then((installed) => {
      if (!installed) return null;  //  Dependencies installing now.  Wait until this Lambda reloads.

      //  Dependencies loaded, so we can use require here.
      //  Call the main function to handle the event.
      //  eslint-disable-next-line import/no-extraneous-dependencies
      const module = require(dependency);
      return module.main(event)
        .then(result => callback(null, result))
        .catch(error => callback(error, null));
    })
    .catch(error => callback(error, null));
};

//  //////////////////////////////////////////////////////////////////////////////////// endregion
//  region Standard Code for AutoInstall.  Do not change.  https://github.com/UnaBiz/sigfox-aws/blob/master/autoinstall.js

/* eslint-disable curly, brace-style, import/no-absolute-path */
let autoinstallPromise = null;  //  Cached autoinstall module.
function autoInstall(package_json0, event0, context0, callback0) {
  //  Set up autoinstall to install any NPM dependencies.  Returns a promise
  //  for "true" when the autoinstall has completed and the script has relaunched.
  //  Else return a promise for "false" to indicate that dependencies are being installed.
  if (__filename.indexOf('/tmp') === 0) return Promise.resolve(true);
  const sourceCode = require('fs').readFileSync(__filename);
  if (!autoinstallPromise) autoinstallPromise = new Promise((resolve, reject) => {
    //  Copy autoinstall.js from GitHub to /tmp and load the module.
    //  TODO: If script already in /tmp, use it.  Else download from GitHub.
    require('https').get(`https://raw.githubusercontent.com/UnaBiz/sigfox-aws/master/autoinstall.js?random=${Date.now()}`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; }); // Accumulate the data chunks.
      res.on('end', () => { //  After downloading from GitHub, save to /tmp amd load the module.
        require('fs').writeFileSync('/tmp/autoinstall.js', body);
        return resolve(require('/tmp/autoinstall')); }); })
      .on('error', (err) => { autoinstallPromise = null; console.error('setupAutoInstall failed', err.message, err.stack); return reject(err); }); });
  return autoinstallPromise
    .then(mod => mod.install(package_json0, event0, context0, callback0, sourceCode))
    .then(() => false)
    .catch((error) => { throw error; });
} /* eslint-enable curly, brace-style, import/no-absolute-path */

//  //////////////////////////////////////////////////////////////////////////////////// endregion
//  region Expected Output

/*
*/

//  //////////////////////////////////////////////////////////////////////////////////// endregion
