/*
 * Copyright 2020 Ally Financial, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License
 * is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing permissions and limitations under
 * the License.
 */

 /* jshint ignore:start */

"use strict";

var path   = require("path"),
    Soda   = require(path.join(__dirname, "..", "SodaCore", "lib", "Soda")),
    Tree   = (require(path.join(__dirname, "..", "SodaCore", "lib", "Tree")))(new Soda({ console: { supress: true } }).init()),
    fs     = require("fs");

require(path.join(__dirname, "..", "SodaCommon", "ProtoLib"));

describe('webTree2 Tree should pass all validation tests on the Login Screen', function () {

    var tree, elements;

    beforeAll(function () {
        tree     = new Tree(JSON.parse(fs.readFileSync(path.resolve(__dirname + "/trees/webTree2.json")).toString('utf-8')));
        elements = tree.elements();
    });

    it('Should find three', function () {
        expect(elements.withSelector(".{boxed} @{High Yield CD} < .{rates-wrap} >[nth=3] .{apy-tier}").length).toEqual(3);
    });
});
