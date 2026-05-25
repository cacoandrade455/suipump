// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

const wasm = require('./nodejs/move_bytecode_template.js');
function init() {}
module.exports = init;
Object.assign(module.exports, wasm, { default: init });
