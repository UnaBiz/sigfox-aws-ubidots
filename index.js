//  sendToUbidots Installation Instructions:
//  Copy and paste the entire contents of lib/lambda.js into a Lambda Function
//  Name: sendToUbidots
//  Runtime: Node.js 6.10
//  Memory: 512 MB
//  Timeout: 5 min
//  Existing Role: lambda_iot (defined according to ../policy/LambdaExecuteIoTUpdate.json)
//  Debugging: Enable active tracing
//  Environment Variables:
//  NODE_ENV=production
//  AUTOINSTALL_DEPENDENCY= sigfox-aws-ubidots
//  AUTOINSTALL_VERSION= >=0.0.6
//  UBIDOTS_API_KEY=Your Ubidots API key
//  LAT_FIELDS=deviceLat,geolocLat
//  LNG_FIELDS=deviceLng,geolocLng

//  Go to AWS IoT, create a Rule:
//  Name: sigfoxSendToUbidots
//  SQL Version: Beta
//  Attribute: *
//  Topic filter: sigfox/types/sendToUbidots
//  Condition: (Blank)
//  Action: Run Lambda Function sendToUbidots

//  Lambda Function sendToUbidots is triggered when a
//  Sigfox message is sent to the message queue sigfox.devices.all.
//  We call the Ubidots API to send the Sigfox message to Ubidots.

//  //////////////////////////////////////////////////////////////////////////////////////////
//  Begin Common Declarations

/* eslint-disable arrow-body-style, max-len, global-require */
process.on('uncaughtException', err => console.error('uncaughtException', err.message, err.stack));  //  Display uncaught exceptions.
process.on('unhandledRejection', (reason, p) => console.error('Unhandled Rejection at:', p, 'reason:', reason));

//  //////////////////////////////////////////////////////////////////////////////////// endregion
//  region AWS-Specific Functions

//  //////////////////////////////////////////////////////////////////////////////////// endregion
//  region Portable Declarations for Google Cloud and AWS

// eslint-disable-next-line import/no-unresolved
const ubidots = require('./lib/ubidots-node');  //  Ubidots API from github.com/UnaBiz/ubidots-node

//  //////////////////////////////////////////////////////////////////////////////////// endregion
//  region Portable Code for Google Cloud and AWS

//  Assume all Sigfox device IDs are 6 letters/digits long.
const DEVICE_ID_LENGTH = 6;

//  Get the API key from environment or config.json.
//  To store two or more keys, separate by comma.
const keys = process.env.UBIDOTS_API_KEY;
if (!keys || keys.indexOf('YOUR_') === 0) {  //  Halt if we see YOUR_API_KEY.
  throw new Error('Environment variable UBIDOTS_API_KEY not defined');
}
const allKeys = keys.split(',');  //  Array of Ubidots API keys.

//  Read the list of lat/lng fields to be renamed.
const configLat = process.env.LAT_FIELDS;
const configLng = process.env.LNG_FIELDS;
let latFields = null;
let lngFields = null;
if (configLat && configLng
  && typeof configLat === 'string'
  && typeof configLng === 'string'
  && configLat.trim().length > 0
  && configLng.trim().length > 0
) {
  latFields = configLat.trim().split(',').map(s => s.trim());
  lngFields = configLng.trim().split(',').map(s => s.trim());
}

//  Map Sigfox device ID to an array of Ubidots datasource and variables:
//  allDevices = '2C30EB' => [{
//    client: Ubidots client used to retrieve the datasource,
//    datasource: Datasource for "Sigfox Device 2C30EB",
//    variables: {
//      lig: { variable record for 'lig' }, ...
//    }},
//    //  Repeat the above for other Ubidots clients that have the same device ID.
//  ]
//  datasource should be present after init().
//  variables and details are loaded upon reference to the device.
//  Each entry is an array, one item per Ubidots client / API key.
let allDevicesPromise = null;

//  Cache of devices by Ubidots client.  Each Ubidots client will have one object in this array.
const clientCache = allKeys.map(apiKey => ({
  apiKey,     //  API Key for the Ubidots client.
  expiry: 0,  //  Expiry timestamp for this cache.  Randomised to prevent 2 clients from refreshing at the same time.
  devicesPromise: Promise.resolve({}),  //  Promise for the map of cached devices.
}));

const expiry = 30 * 1000;  //  Devices expire in 30 seconds, so they will be auto refreshed from Ubidots.

function wrap() {
  //  Wrap the module into a function so that all Cloud resources are properly disposed.
  const scloud = require('sigfox-aws'); //  sigfox-aws Framework
  let wrapCount = 0;

  function promisfy(func) {
    //  Convert the callback-style function in func and return as a promise.
    return new Promise((resolve, reject) =>
      func((err, res) => (err ? reject(err) : resolve(res))))
      .catch((error) => { throw error; });
  }

  /* allDatasources contains [{
      "id": "5933e6897625426a4f6efd1b",
      "owner": "http://things.ubidots.com/api/v1.6/users/26539",
      "label": "sigfox-device-2c30eb",
      "parent": null,
      "name": "Sigfox Device 2C30EB",
      "url": "http://things.ubidots.com/api/v1.6/datasources/5933e6897625426a4f6efd1b",
      "context": {},
      "tags": [],
      "created_at": "2017-06-04T10:52:57.172",
      "variables_url": "http://things.ubidots.com/api/v1.6/datasources/5933e6897625426a4f6efd1b/variables",
      "number_of_variables": 3,
      "last_activity": null,
      "description": null,
      "position": null}, ...] */

  function processDatasources(req, allDatasources0, client) {
    //  Process all the datasources from Ubidots.  Each datasource (e.g. Sigfox Device 2C30EB)
    //  should correspond to a Sigfox device (e.g. 2C30EB). We index all datasources
    //  by Sigfox device ID for faster lookup.  Assume all devices names end with
    //  the 6-char Sigfox device ID.  Return a map of device IDs to datasource.
    if (!allDatasources0) return {};
    let normalName = '';
    const devices = {};
    for (const ds of allDatasources0) {
      //  Normalise the name to uppercase, hex digits.
      //  "Sigfox Device 2C30EB" => "FDECE2C30EB"
      const name = ds.name.toUpperCase();
      for (let i = 0; i < name.length; i += 1) {
        const ch = name[i];
        if (ch < '0' || ch > 'F' || (ch > '9' && ch < 'A')) continue;
        normalName += ch;
      }
      //  Last 6 chars is the Sigfox ID e.g. '2C30EB'.
      if (normalName.length < DEVICE_ID_LENGTH) {
        scloud.log(req, 'processDatasources', { msg: 'name_too_short', name, device: req.device });
        continue;
      }
      const device = normalName.substring(normalName.length - DEVICE_ID_LENGTH);
      //  Merge the client and datasource into the map of all devices.
      devices[device] = Object.assign({}, devices[device], { client, datasource: ds });
    }
    return devices;
  }

  /* A variable record looks like: {
    "id": "5933e6977625426a5efbaaef",
    "name": "lig",
    "icon": "cloud-upload",
    "unit": null,
    "label": "lig",
    "datasource": {
    "id": "5933e6897625426a4f6efd1b",
      "name": "Sigfox Device 2C30EB",
      "url": "http://things.ubidots.com/api/v1.6/datasources/5933e6897625426a4f6efd1b"
    },
    "url": "http://things.ubidots.com/api/v1.6/variables/5933e6977625426a5efbaaef",
    "description": null,
    "properties": {},
    "tags": [],
    "values_url": "http://things.ubidots.com/api/v1.6/variables/5933e6977625426a5efbaaef/values",
    "created_at": "2017-06-04T10:53:11.037",
    "last_value": {},
    "last_activity": null,
    "type": 0,
    "derived_expr": "" } */

  function getVariablesByDevice(req, allDevices0, device) {
    //  Fetch an array of Ubidots variables for the specified Sigfox device ID.
    //  The array is compiled from all Ubidots clients with the same device ID.
    //  Each array item is a variables map (name => variable record).
    //  Returns a promise.
    const devices = allDevices0[device];
    if (!devices || !devices[0]) {
      return Promise.resolve(null);  //  No such device.
    }
    //  Load the variables from each Ubidots client sequentially, not in parallel.
    const result = [];
    let promises = Promise.resolve('start');
    devices.forEach((dev) => {
      if (dev.variables) {
        result.push(dev.variables);  //  Return cached variables.
        return;
      }
      //  Given the datasource, read the variables from Ubidots.
      const client = dev.client;
      const datasourceId = dev.datasource.id;
      const datasource = client.getDatasource(datasourceId);
      promises = promises
        .then(() => promisfy(datasource.getVariables.bind(datasource)))
        .then((res) => {
          if (!res) return null;  //  No variables.
          return res.results;
        })
        .then((res) => {
          //  Index the variables by name.
          if (!res) return {};  //  No variables.
          const vars = {};
          for (const v of res) {
            const name = v.name;
            vars[name] = v;
          }
          Object.assign(dev, { variables: vars });
          return vars;
        })
        .then((res) => { result.push(res); })
        //  Suppress the error, continue with the next device.
        .catch((error) => { scloud.error(req, 'getVariablesByDevice', { error, device }); return error; });
    });
    return promises.then(() => result);
  }

  function setVariables(req, clientDevice, allValues) {
    //  Set the Ubidots variables for the specified Ubidots device,
    //  for a single Ubidots client only.  allValues looks like:
    //  varname => {"value": "52.1", "timestamp": 1376056359000,
    //    "context": {"lat": 6.1, "lng": -35.1, "status": "driving"}}'
    //  Returns a promise.
    if (!clientDevice) return Promise.resolve(null);  //  No such device.
    //  Resolve each variable name to variable ID.
    const allValuesWithID = [];
    for (const varname of Object.keys(allValues)) {
      const val = allValues[varname];
      const v = clientDevice.variables[varname];
      if (!v) continue;  //  No such variable.
      const varid = v.id;
      allValuesWithID.push(Object.assign({}, val, { variable: varid }));
    }
    //  Call the Ubidots API and update multiple variables.
    //  Note: This setValues API is not exposed in the original Node.js Ubidots library.
    //  Must use the forked version by UnaBiz.
    if (allValuesWithID.length === 0) return Promise.resolve(null);  //  No updates.
    const client = clientDevice.client;
    return new Promise((resolve, reject) =>
      client.setValues(allValuesWithID, (err, res) =>
        (err ? reject(err) : resolve(res))))
      .then(result => scloud.log(req, 'setVariables', { result, allValues, device: req.device }))
      .catch((error) => { scloud.error(req, 'setVariables', { error, allValues, device: req.device }); throw error; });
  }

  function loadDevicesByClient(req, client) {
    //  Preload the Ubidots Devices / Datasources for the Ubidots client.
    //  Returns a promise for the map of devices.

    //  Must bind so that "this" is correct.
    return promisfy(client.auth.bind(client))
      //  Get the list of datasources from Ubidots.
      .then(() => promisfy(client.getDatasources.bind(client)))
      .then((res) => {
        if (!res) throw new Error('no_datasources');
        return res.results;
      })
      //  Convert the datasources to a map of devices.
      .then(res => processDatasources(req, res, client))
      .catch((error) => { scloud.error(req, 'loadDevicesByClient', { error, device: req.device }); throw error; });
  }

  function mergeDevices(req, devicesArray) {
    //  devicesArray contains an array of device maps e.g.
    //    devicesArray[0] = { deviceID1: device1, deviceID2: device2, ... }
    //  Return a map of device IDs to the array of devices with the same ID.
    //    { deviceID1: [ device1, ... ], ... }

    //  Get a list of device IDs, includes duplicates.
    const allDeviceIDs = devicesArray.reduce((merged, devices) =>
      merged.concat(Object.keys(devices)), []);

    //  For each device ID, map it to the list of devices for that ID.
    return allDeviceIDs.reduce((merged, deviceID) => {
      //  If this device ID is duplicate, skip it.
      if (merged[deviceID]) return merged;
      //  For the same device ID, concat the devices from all clients into an array.
      const newMerged = Object.assign({}, merged);
      newMerged[deviceID] = devicesArray.reduce((concat, devices) =>
          devices[deviceID]  //  Concat non-null devices.
            ? concat.concat([devices[deviceID]])
            : concat,
        []);
      return newMerged;
    }, {});
  }

  function loadCache(req, cache) { /*  eslint-disable no-param-reassign  */
    //  Load the cache of devices for the specific Ubidots client if it has expired.
    //  Returns a promise for the map of devices.  Warning: Mutates the cache object.
    if (cache.devicesPromise && cache.expiry >= Date.now()) {
      return cache.devicesPromise;
    }
    //  Randomise the expiry so we don't fetch 2 clients at the same time.
    cache.expiry = Date.now() + Math.floor(Math.random() * expiry);
    const client = ubidots.createClient(cache.apiKey);
    const prevDevices = cache.devicesPromise;
    scloud.log(req, 'loadCache', { device: req.device, apiKey: `${cache.apiKey.substr(0, 10)}...` });
    cache.devicesPromise = loadDevicesByClient(req, client)
      .catch((error) => {
        scloud.error(req, 'loadCache', { error, device: req.device, apiKey: `${cache.apiKey.substr(0, 10)}...` });
        //  In case of error, return the previous result.
        cache.devicesPromise = prevDevices;
        return prevDevices;
      });
    return cache.devicesPromise;
  }  /*  eslint-enable no-param-reassign  */

  function loadAllDevices(req) {
    //  Load the devices for the specified Ubidots API keys,
    //  when multiple Ubidots accounts / API keys are provided.
    //  If already loaded and not expired, return the previously loaded devices.
    //  Returns a promise for the map of device IDs to array of devices for the ID:
    //    { deviceID1: [ device1, ... ], ... }
    //  If any cache has not expired, return the previous results.
    if (allDevicesPromise && !clientCache.find(cache => (cache.expiry <= Date.now()))) {
      return allDevicesPromise;
    }
    //  Else recache each Ubidots client.
    const allDevices = [];
    let promise = Promise.resolve('start');
    for (const cache of clientCache) {
      //  Fetch the devices sequentially, not in parallel, so we don't overload Ubidots.
      promise = promise
        .then(() => loadCache(req, cache))
        .then(devices => allDevices.push(devices));
    }
    //  Load the devices for each Ubidots client.
    allDevicesPromise = promise
      //  Consolidate the array of devices by client and cache it.
      .then(() => mergeDevices(req, allDevices))
      .catch((error) => {
        //  In case of error, don't cache.
        allDevicesPromise = null;
        scloud.error(req, 'loadAllDevices', { error, device: req.device });
        throw error;
      });
    return allDevicesPromise;
  }

  function transformBody(req, body0) {
    //  Transform any lat/lng fields in the body to the Ubidots geopoint format.
    //  Rename lat/lng to baseStationLat/baseStationLng. This is the original
    //  truncated lat/lng provided by Sigfox.  If config file contains
    //    lat=latfield1,latfield2,...
    //    lng=lngfield1,lngfield2,...
    //  Then rename latfield1/lngfield1 to lat/lng, latfield2/lngfield2 to lat/lng
    //  whichever occurs first. Ubidots will only render a point on the map
    //  when lat/lng appears in the context. See
    //  https://ubidots.com/docs/api/#send-values-to-one-variable
    const body = Object.assign({}, body0);
    if (body.lat) { body.baseStationLat = body.lat; delete body.lat; }
    if (body.lng) { body.baseStationLng = body.lng; delete body.lng; }
    if (!latFields || !lngFields) return body;

    //  Search for latfield1,lngfield1 then latfield2,lngfield2, ...
    const len = Math.min(latFields.length, lngFields.length);
    for (let i = 0; i < len; i += 1) {
      const latField = latFields[i];
      const lngField = lngFields[i];
      if (latField.length === 0 || lngField.length === 0) continue;
      if (!body[latField] || !body[lngField]) continue;
      //  Found the lat and lng fields.  Copy them to lat/lng and exit.
      body.lat = body[latField];
      body.lng = body[lngField];
      break;
    }
    return body;
  }

  function task(req, device, body0, msg) {
    //  The task for this Google Cloud Function: Record the body of the
    //  Sigfox message in Ubidots by calling the Ubidots API.
    //  We match the Sigfox device ID with the datasources already defined
    //  in Ubidots, match the Sigfox message fields with the Ubidots
    //  variables, and populate the values.  All datasources, variables
    //  must be created in advance.  If the device ID exists in multiple
    //  Ubidots accounts, all Ubidots accounts will be updated.
    wrapCount += 1; console.log({ wrapCount }); //
    //  Skip duplicate messages.
    if (body0.duplicate === true || body0.duplicate === 'true') {
      return Promise.resolve(msg);
    }
    if (body0.baseStationTime) {
      const baseStationTime = parseInt(body0.baseStationTime, 10);
      const age = Date.now() - (baseStationTime * 1000);
      console.log({ baseStationTime });
      if (age > 5 * 60 * 1000) {
        //  If older than 5 mins, reject.
        throw new Error(`too_old: ${age}`);
      }
    }
    //  Transform the lat/lng in the message.
    Object.assign(req, { device });
    const body = transformBody(req, body0);

    //  Load the Ubidots datasources if not already loaded.
    let allDevices0 = null;
    return loadAllDevices(req, allKeys)
      .then((res) => { allDevices0 = res; })
      //  Load the Ubidots variables for the device if not loaded already.
      .then(() => getVariablesByDevice(req, allDevices0, device))
      .then(() => {
        //  Find all Ubidots clients and datasource records for the Sigfox device.
        const devices = allDevices0[device];
        if (!devices || !devices[0]) {
          scloud.log(req, 'missing_ubidots_device', { device, body, msg });
          return null;  //  No such device.
        }
        //  Update the datasource record for each Ubidots client.
        return Promise.all(devices.map((dev) => {
          //  For each Sigfox message field, set the value of the Ubidots variable.
          if (!dev || !dev.variables) return null;
          const vars = dev.variables;
          const allValues = {};  //  All vars to be set.
          for (const key of Object.keys(vars)) {
            if (!body[key]) continue;
            //  value looks like
            //  {"value": "52.1", "timestamp": 1376056359000,
            //    "context": {"lat": 6.1, "lng": -35.1, "status": "driving"}}'
            const value = {
              value: body[key],
              timestamp: parseInt(body.timestamp, 10),  //  Basestation time.
              context: Object.assign({}, body),  //  Entire message.
            };
            if (value.context[key]) delete value.context[key];
            allValues[key] = value;
          }
          //  Set multiple variables with a single Ubidots API call.
          return setVariables(req, dev, allValues);
        }))
          .catch((error) => { scloud.error(req, 'task', { error, device, body, msg }); throw error; });
      })
      //  Return the message for the next processing step.
      .then(() => msg)
      .catch((error) => { scloud.error(req, 'task', { error, device, body, msg }); throw error; });
  }

  return {
    //  Expose these functions outside of the wrapper.
    //  When this Google Cloud Function is triggered, we call main() which calls task().
    serveQueue: event => scloud.main(event, task),

    //  For unit test only.
    task,
    loadDevicesByClient,
    getVariablesByDevice,
    setVariables,
    mergeDevices,
  };
}

//  End Message Processing Code
//  //////////////////////////////////////////////////////////////////////////////////////////

//  //////////////////////////////////////////////////////////////////////////////////////////
//  Main Function

const wrapper = wrap();

module.exports = {
  //  Expose these functions to be called by Google Cloud Function.

  main: (event) => {
    //  Create a wrapper and serve the PubSub event.
    return wrapper.serveQueue(event)
      //  Suppress the error or Google Cloud will call the function again.
      .catch(error => error);
  },

  //  For unit test only.
  task: wrap().task,
  loadDevicesByClient: wrap().loadDevicesByClient,
  getVariablesByDevice: wrap().getVariablesByDevice,
  setVariables: wrap().setVariables,
  mergeDevices: wrap().mergeDevices,
  allKeys,
};
