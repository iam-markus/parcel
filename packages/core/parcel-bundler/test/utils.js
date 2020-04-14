const {ncp} = require('ncp');
const {promisify} = require('@parcel/utils');

exports.ncp = promisify(ncp);
