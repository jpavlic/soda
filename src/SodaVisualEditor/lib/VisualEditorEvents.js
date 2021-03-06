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

 /**
 * @module SodaVisualEditor/VisualEditorEvents
 * @description A callback for socket requests from the Soda Visual Editor
 */

var nodePath = require("path"),
    exec     = require("child_process").exec,
    fs       = require("fs"),
    PNGCrop = require('png-crop'),

    Soda   = require(nodePath.join(__dirname, "..", "..", "SodaCore")),
    Asset  = require(nodePath.join(__dirname, "..", "..", "SodaCore", "lib", "Classes", "Asset")),
    cypher = require(nodePath.join(__dirname, "..", "..", "SodaCommon", "Cypher.js")),

    imageCount = 0,
    treeCount  = 0,

    lastTree    = {},
    Collections = {},
    Instance    = {};

/**
 * A pseudo action, to grab the syntax listings for each syntax definition to send over to the Visual Editor
 * @constructor
 */
var PseduoAction = function () {
    var syntaxes = {};

    /**
     * Callback for when objects of the syntax are emitted
     * @param  {String} event The event name
     * @param  {Function} func The callback function for this event
     * @param  {String} type The action type (e.g. screen, menu, action, etc.)
     * @param  {String} group The action group name
     * @param  {String} description A description of the action
     * @param  {Boolean} nonElemental Whether or not the action performs on elements
     * @return {undefined}
     */
    this.on = function (event, func, type, group, description, nonElemental) {
        if(type !== "hide") {
            var e = {
                keys         : event.split(":").slice(1),
                description  : description,
                nonElemental : nonElemental || false
            };

            group = group || "ungrouped";
            type  = type  || "action";

            if(!syntaxes[type]) syntaxes[type] = {};
            if(!syntaxes[type][group]) syntaxes[type][group] = [];
            syntaxes[type][group].push(e);
        }
    };

    /**
     * A fake syntax definition
     * @return {Object}
     */
    this.getSyntax = function () { return syntaxes; };
};

/**
 * A functions, which when invoked attaches all the listeners to the socket server provided.
 * The server must inherit from EventEmitter
 * @param {SocketServer} server The socket server to subscribe listeners to
 * @param {REPL} repl The repl for this Soda instance (or just a REPL instance)
 * @param {Soda=} sodaToAttach A Soda instance to associate with this socket instance. If none is specified, a new one will be created.
 * @param {Function} done A callback for completion
 * @composes onSoda
 */
function VisualEditorEvents (server, repl, sodaToAttach, done) {
    var attached = false;

    if(!done && (sodaToAttach !== "object" || (sodaToAttach && typeof sodaToAttach.yid === "number")) && sodaToAttach instanceof Function) {
        done         = sodaToAttach;
        sodaToAttach = null;
    }

    return function visualEditorEvents (socket) {
        var sodaInstance, userFavorites, userSettings;

        /**
         * Emit the "framework died" event if the framework instance dies
         * @return {undefined}
         */
        function onceOnExit () {
            socket.emit("framework died");
        }

        /**
         * Once a soda instance has been established, this will be invoked
         * @param  {SodaError|Error|null} err A soda initialization error, if one exists
         * @param  {object<Soda>} soda An initialized Soda instance
         * @memberof module.SodaVisualEditor/VisualEditorEvents.VisualEditorEvents
         * @return {*}
         */
        function onSoda (err, soda) {

            if(err) {
                server.stop(function () {
                    if(done instanceof Function) done.call(soda, err);
                });
            }

            // Set the port being used...
            soda.config.set("port", server.port);

            // Handle errors by not handling them...
            socket.on("connect_error", function (err) {
                soda.console.error(err ? err.stack : new Error("Unknown Error").stack);
            });

            // Start up the Soda REPL
            repl.init(soda);
            repl.switchToSodaUsingYid(soda.yid);

            // Attempt to load the user's favorites
            fs.readFile(soda.config.get("veUserFavorites"), function (err, fc) {
                if(err) {
                    userFavorites = [];
                }
                else {
                    try {
                        userFavorites = JSON.parse(fc.toString('utf-8'));
                    }
                    catch(e) {
                        soda.console.error("*** The user favorites file has become corrupt, it has been purged. ***");
                        userFavorites = [];
                    }
                }
            });

            // Attempt to load the user's settings
            fs.readFile(soda.config.get("veUserSettings"), function (err, fc) {
                if(err) {
                    userSettings = {};
                }
                else {
                    try {
                        userSettings = JSON.parse(fc.toString('utf-8'));
                    }
                    catch(e) {
                        soda.console.error("*** The user settings file has become corrupt, it has been purged. ***");
                        userSettings = {};
                    }
                }
            });

            /**
             * Responds to the event passed in with a reply containing "data"
             * @param  {object} request A socket request object
             * @param  {object} response A socket response object
             * @return {*}
             */
            function respondTo(request, data) {

                var response = {
                    error : null,
                    time  : Date.now(),
                    pid   : process.pid,
                    yid   : soda ? soda.yid : -1,
                    rid   : request.id,
                    data  : data
                };

                if(soda) {
                    if(data instanceof Error || data instanceof soda.exception.SodaError) response.error = data.toString();
                }
                else {
                    if(data instanceof Error) response.error = data.toString();
                }
                return socket.emit("response " + request.rid, response);
            }

            /**
             * Update a configuration value
             * @param {String} name The name of the configuration value to set
             * @param {*} value The value to set it to
             * @param {Object} config The config object
             * @return {undefined}
             */
            function configUpdate (name, value, config) {
                socket.emit("config update", config);
            }

            /**
             * Get the syntax definitions for the given syntax
             * @param  {object} request The client request object
             * @composes PseduoAction
             * @return {*}
             */
            function getSyntax (request) {
                var pseduoAction = new PseduoAction();
                soda.syntax.get(pseduoAction, request.data.name, request.data.version);
                respondTo(request, pseduoAction.getSyntax());
            }

            /**
             * Saves a user's favorites
             * @param done A callback for completion
             * @return {*}
             */
            function saveUserFavorites (newFavorites, done) {
                try {
                    userFavorites = newFavorites;
                    var userFavoritesJSON = userFavorites.stringified(null, '    ');
                    fs.writeFile(soda.config.get("veUserFavorites"), userFavoritesJSON, done);
                }
                catch(e) {
                    soda.console.error("*** The user favorites file has become corrupt, it has been purged. ***");
                    userFavorites = [];

                    fs.writeFile(soda.config.get("veUserFavorites"), "[]", function (err) {
                        if(err) {
                            if(done instanceof Function) done(err);
                        }
                        else {
                            if(done instanceof Function) done(e);
                        }
                    });
                }
            }

            /**
             * Saves a user's setting
             * @param done A callback for completion
             * @return {*}
             */
            function saveUserSettings (newSettings, done) {
                try {
                    for (var key in newSettings) {
                      if (newSettings.hasOwnProperty(key)) {
                        userSettings[key] = newSettings[key];
                      }
                    }

                    fs.writeFile(soda.config.get("veUserSettings"), userSettings.stringified(null, '    '), done);
                }
                catch(e) {
                    soda.console.error("*** The user settings file has become corrupt, it has been purged. ***");
                    userSettings = {};

                    fs.writeFile(soda.config.get("veUserSettings"), "{}", function (err) {
                        if(err) {
                            if(done instanceof Function) done(err);
                        }
                        else {
                            if(done instanceof Function) done(e);
                        }
                    });
                }
            }

            /**
             * Pipes output to the socket client
             * @param  {Array} messages An array of console messages
             * @return {*}
             */
            function pipeOutput (messages, htmlMessages) {
                return socket.emit("stdout", htmlMessages);
            }

            /**
             * Gets the current framework status
             * @param  {object} request The client request object
             * @return {*}
             */
            function getStatus (request) {
                return respondTo(request, {
                    started  : soda.framework.started,
                    name     : soda.framework.name,
                    platform : soda.config.get("platform"),
                    args     : soda.framework.args,
                    testPath : soda.config.get("testPath"),
                    testResultsPath : soda.config.get("testResultsPath"),
                    version  : soda.framework.version,
                    device   : soda.framework.device,
                    syntax   : { name: soda.framework.defaultSyntaxName, version: soda.framework.defaultSyntaxVersion },
                    config   : soda.config.get(),
                    env      : soda.config.get("env")
                });
            }

            /**
             * Sends an image in response to the given request
             * @param  {object} request The client request object
             * @param  {string} imagePath The path to the image file
             * @return {*}
             */
            function sendImage (request, imagePath, base64) {
                if (base64) {
                    var imageObject = {
                        path   : imagePath,
                        number : imageCount++,
                        base64 : base64
                    };
                    return respondTo(request, imageObject);
                }

                fs.readFile(imagePath, function (err, fc) {
                    if(err) return respondTo(request, err);

                    var imageObject = {
                        path   : imagePath,
                        number : imageCount++,
                        base64 : fc.toString('base64')
                    };
                    return respondTo(request, imageObject);
                });
            }

            /**
             * Get's an DOM tree
             * @param  {object} request The client request object
             * @return {*}
             */
            function getTreeUpdate (request) {
                soda.framework.getTree(function (err, tree) {
                    if(err) return respondTo(request, err);
                    lastTree[socket.id] = tree;
                    return respondTo(request, {
                        generated  : Date.now(),
                        contents   : tree.contents,
                        treeNumber : treeCount++,
                        hash       : tree.hash
                    });
                });
            }

            /**
             * Query the element tree with a selector, name, etc.
             * @param  {object} request The client request object
             * @return {undefined}
             */
            function queryTree (request) {
                if(
                    lastTree[socket.id]                         &&
                    typeof lastTree[socket.id] === "object"     &&
                    typeof request === "object"                 &&
                    typeof request.data === "object"            &&
                    (typeof request.data.value === "string" || request.data.value instanceof Array) &&
                    lastTree[socket.id]["findElementsBy" + request.data.type.ucFirst] instanceof Function
                ) {
                    var elIds = [], bySet = [];
                    if(request.data.value instanceof Array && request.data.type.toLowerCase() === "selector") {
                        lastTree[socket.id].findElementsBySelectorSet(request.data.value, function (err, matchedElements) {
                            if(err) return respondTo(request, err);
                            matchedElements.flat.sodaeach(function (e) { elIds.push(e.id); });
                            matchedElements.bySet.sodaeach(function (s, i) {
                                bySet[i] = [];
                                s.sodaeach(function (e) { bySet[i].push(e.id); });
                            });
                            respondTo(request, { flat: elIds, bySet: bySet });
                        });
                    }
                    else if(request.data.value !== "") {
                        lastTree[socket.id]["findElementsBy" + request.data.type.ucFirst](request.data.value, function (err, matchedElements) {
                            if(err) return respondTo(request, err);
                            matchedElements.sodaeach(function (e) { elIds.push(e.id); });
                            respondTo(request, elIds);
                        });
                    }
                    else {
                        respondTo(request, []);
                    }
                }
                else {
                    respondTo(request, []);
                }
            }

            /**
             * Get the configuration settings
             * @param  {object} request The client request object
             * @return {*}
             */
            function getConfig (request) {
                return respondTo(request, soda.config.get());
            }

            /**
             * Update a configuration variable
             * @param  {object} request The client request object
             * @return {*}
             */
            function updateConfig (request) {
                soda.config.set(request.data.name, request.data.value);
                return respondTo(request, soda.config.get());
            }

            /**
             * Get's an updated screenshot
             * @param  {object} request The client request object
             * @return {*}
             */
            function getScreenUpdate (request) {
                var destination = nodePath.join(soda.config.get("temp"), "Screen-" + soda.toString().replace(/[^a-z0-9]/ig, '') + ".png");

                setTimeout(function() {
                    // Caputre the screen using the device
                    soda.device.captureScreen({ filename: "Screen-" + soda.toString().replace(/[^a-z0-9]/ig, ''), destination: destination }, function (err, res, base64) {
                        if(err) return respondTo(request, err);

                        // Get the device's orientation
                        soda.framework.getOrientation(function (err, orientation) {
                            if(err) orientation = 1;

                            // If this is iOS, rotate it
                            if(soda.framework.name.toLowerCase() === "instruments" && orientation > 1 && orientation <= 4) {
                                var cmd = "sips -r ";
                                switch(orientation) {
                                    case 2:
                                        cmd += "180 " + destination;
                                    break;

                                    case 3:
                                        cmd += "-90 " + destination;
                                        break;

                                    case 4:
                                        cmd +=  "90 " + destination;
                                        break;
                                    
                                    default:
                                        cmd += "180 " + destination;
                                        break;
                                }
                                soda.console.debug("Instruments: rotating image for Soda VisualEditor");
                                exec(cmd, function (err, stdout, stderr) {
                                    if(err) return respondTo(request, err);
                                    if(err) return respondTo(request, new soda.exception.ExecutionError(stderr));
                                    return sendImage(request, destination);
                                });
                            }
                            else if(soda.framework.name.toLowerCase() === "selenium" && (soda.framework.device.toLowerCase() === "internet explorer")) {
                                if (lastTree[socket.id]) {
                                    lastTree[socket.id]["findElementsById"](soda.config.get("sodaRootId"), function (err, matchedElements) {
                                        if (destination) {
                                            try {
                                                PNGCrop.crop(destination, destination, { left: matchedElements[0].rect.origin.x, top: matchedElements[0].rect.origin.y, width: matchedElements[0].rect.size.width, height: matchedElements[0].rect.size.height }, function(err) {
                                                    return sendImage(request, destination, base64);
                                                });
                                            }
                                            catch(err) {
                                                console.error(err);
                                            }
                                        }
                                        else {
                                            return sendImage(request, destination, base64);
                                        }
                                    });
                                }
                                else {
                                    return sendImage(request, destination, base64);
                                }
                            }
                            // Not iOS, just send the image on...
                            else {
                                return sendImage(request, destination, base64);
                            }
                        });
                    });
                }, soda.config.get("timeToWaitForScreenShot"));
            }

            /**
             * Emits "asset load"
             */
            function onAssetLoad () {
                socket.emit("asset load");
            }

            /**
             * Starts a Soda framework
             * @param  {object} request A socket request object
             * @return {*}
             */
            function startFramework (request) {
                if(soda.framework.started === false) {
                    // Replace all instances of ~ in data with the user home directory
                    request.data.sodaeach(function replaceTildeWithHome (v, k, i, p) {
                        if(v && typeof v === "object" && v.isObjectNotArray) {
                            v.sodaeach(replaceTildeWithHome);
                        }
                        else if(typeof v === "string") {
                            p[k] = v.replace(/~/g, soda.config.get("userHome").withoutTrailingSlash);
                        }
                    });

                    // Set the platform
                    if(typeof request.data.platform === "string" && request.data.platform !== "")
                    {
                        soda.config.set("platform", request.data.platform);
                    }

                    // Set the framework
                    if(typeof request.data.framework === "string" && request.data.framework !== "")
                        soda.config.set("framework", request.data.framework);

                    // Set the environment
                    if(typeof request.data.env === "string" && request.data.env !== "") {
                        soda.config.set("env", request.data.env);
                        soda.vars.save("_env_", request.data.env, true);
                    }

                    // Reset Device?
                    if(typeof request.data.options === "object" && request.data.options.resetDevice) {
                        soda.config.set("resetDevice", true);
                    }

                    // Set the optional proxy, if available
                    if(typeof request.data.options === "object" && request.data.options.proxy) {
                        if(typeof request.data.options.proxyUser === "string" &&
                           typeof request.data.options.proxyPass === "string" &&
                           request.data.options.proxyPass !== ""              &&
                           request.data.options.proxyUser !== ""
                        ) {
                            try {
                                soda.config.set(
                                    "proxy",
                                    "http://" + request.data.options.proxyUser     + ":" +
                                    cypher.decrypt(request.data.options.proxyPass) + "@" +
                                    request.data.options.proxy
                                        .replace(/^http(s)?:\/\//, '')
                                );
                            }
                            catch(err) {
                                soda.console.error("Unable to parse proxy password, favorites file is likely corrupt. Continuing without proxy credentials.");
                                soda.config.set("proxy", request.data.options.proxy);
                            }
                        }
                        else {
                            soda.config.set("proxy", request.data.options.proxy);
                        }
                    }

                    // Check for required fields
                    if (request.data.platform !== "windows" && (!request.data.device || request.data.device === "")) {
                        return respondTo(request, new soda.exception.InvalidFrameworkArguments("No device (emulator) specified"));
                    }

                    if (request.data.framework === "perfecto") {
                        request.data.device = request.data.deviceid;
                    }

                    if(!request.data.testPath || request.data.testPath === "")
                        return respondTo(request, new soda.exception.InvalidFrameworkArguments("No project path specified"));

                    if(!request.data.testResultsPath || request.data.testResultsPath === "")
                        return respondTo(request, new soda.exception.InvalidFrameworkArguments("No test results path specified"));

                    if(!request.data.app || request.data.app === "")
                        return respondTo(request, new soda.exception.InvalidFrameworkArguments("No application (apk or build path) specified"));

                    // Load the correct assets
                    soda.loadAssets(request.data.testPath, function (err, collection) {
                        if(err) return respondTo(request, err);

                        Collections[socket.id] = collection;
                        Collections[socket.id].on("assets loaded", onAssetLoad);

                        if (request.data.framework === "instruments") {
                          // Load and start the framework
                          soda.framework
                              .load(request.data.framework)
                              .start(request.data.device, request.data.apppath, request.data.bundleid, request.data.options, function (err, started, instance) {
                                  if(err) {
                                      return respondTo(request, err);
                                  }
                                  else if(!started) {
                                      return respondTo(request, new Error("Unknown Error: Unable to start framework"));
                                  }
                                  else {

                                      if(instance && instance.on instanceof Function) {
                                          Instance[socket.id] = instance;
                                          instance.on("exit", onceOnExit);
                                      }

                                      var response = {
                                          started  : Date.now(),
                                          device   : soda.framework.device,
                                          name     : soda.framework.name,
                                          platform : soda.config.get("platform"),
                                          version  : soda.framework.version,
                                          config   : soda.config.get(),
                                          args     : soda.framework.args,
                                          testPath : soda.config.get("testPath"),
                                          testResultsPath : soda.config.get("testResultsPath"),
                                          syntax   : { name: soda.framework.defaultSyntaxName, version: soda.framework.defaultSyntaxVersion },
                                          workspace: request.data.workspace ? request.data.workspace : "",
                                          target   : request.data.target ? request.data.target : "",
                                          bundleid   : request.data.bundleid ? request.data.bundleid : "",
                                          app   : request.data.app ? request.data.app : "",
                                          apppath: request.data.apppath ? request.data.apppath : "",
                                          buildpath: request.data.buildpath ? request.data.buildpath : ""
                                      };
                                      return respondTo(request, response);
                                  }
                              });
                        }
                        else if (request.data.framework === "perfecto") {
                          // Load and start the framework
                          soda.framework
                              .load(request.data.framework)
                              .start(request.data.device, request.data.app, request.data.testPath, request.data.target, request.data.buildpath, request.data.options, function (err, started, instance) {
                                  if(err) {
                                      return respondTo(request, err);
                                  }
                                  else if(!started) {
                                      return respondTo(request, new Error("Unknown Error: Unable to start framework"));
                                  }
                                  else {

                                      if(instance && instance.on instanceof Function) {
                                          Instance[socket.id] = instance;
                                          instance.on("exit", onceOnExit);
                                      }

                                      var response = {
                                          started  : Date.now(),
                                          device   : soda.framework.device,
                                          name     : soda.framework.name,
                                          platform : soda.config.get("platform"),
                                          version  : soda.framework.version,
                                          config   : soda.config.get(),
                                          args     : soda.framework.args,
                                          testPath : soda.config.get("testPath"),
                                          testResultsPath : soda.config.get("testResultsPath"),
                                          syntax   : { name: soda.framework.defaultSyntaxName, version: soda.framework.defaultSyntaxVersion },
                                          workspace: request.data.workspace ? request.data.workspace : "",
                                          target   : request.data.target ? request.data.target : "",
                                          app   : request.data.app ? request.data.app : "",
                                          apppath: request.data.apppath ? request.data.apppath : "",
                                          buildpath: request.data.buildpath ? request.data.buildpath : ""
                                      };
                                      return respondTo(request, response);
                                  }
                              });
                        }
                        else {
                          // Load and start the framework
                          soda.framework
                              .load(request.data.framework)
                              .start(request.data.device, request.data.app, request.data.options, function (err, started, instance) {
                                  if(err) {
                                      return respondTo(request, err);
                                  }
                                  else if(!started) {
                                      return respondTo(request, new Error("Unknown Error: Unable to start framework"));
                                  }
                                  else {

                                      if(instance && instance.on instanceof Function) {
                                          Instance[socket.id] = instance;
                                          instance.on("exit", onceOnExit);
                                      }

                                      var response = {
                                          started  : Date.now(),
                                          device   : soda.framework.device,
                                          name     : soda.framework.name,
                                          platform : soda.config.get("platform"),
                                          version  : soda.framework.version,
                                          config   : soda.config.get(),
                                          args     : soda.framework.args,
                                          testPath : soda.config.get("testPath"),
                                          testResultsPath : soda.config.get("testResultsPath"),
                                          syntax   : { name: soda.framework.defaultSyntaxName, version: soda.framework.defaultSyntaxVersion },
                                          workspace: request.data.workspace ? request.data.workspace : "",
                                          target   : request.data.target ? request.data.target : "",
                                          app   : request.data.app ? request.data.app : "",
                                          apppath: request.data.apppath ? request.data.apppath : "",
                                          buildpath: request.data.buildpath ? request.data.buildpath : ""
                                      };
                                      return respondTo(request, response);
                                  }
                              });
                        }
                    });
                }
                else {
                    var response = {
                        started  : Date.now(),
                        device   : soda.framework.device,
                        name     : soda.framework.name,
                        platform : soda.config.get("platform"),
                        version  : soda.framework.version,
                        config   : soda.config.get(),
                        args     : soda.framework.args,
                        testPath : soda.config.get("testPath"),
                        testResultsPath : soda.config.get("testResultsPath"),
                        workspace: request.data.workspace ? request.data.workspace : "",
                        target   : request.data.target ? request.data.target : "",
                        buildpath: request.data.buildpath ? request.data.buildpath : ""
                    };
                    return respondTo(request, response);
                }
            }

            /**
             * Stops a Soda framework
             * @param  {object} request A socket request object
             * @return {*}
             */
            function stopFramework (request) {
                if(soda.framework.started) {
                    if(Instance[socket.id]) {
                        Instance[socket.id].removeListener("exit", onceOnExit);
                    }

                    soda.framework.stop(function (err) {
                        if(err) return respondTo(request, false);
                        respondTo(request, true);
                    });
                }
                else {
                    respondTo(request, true);
                }
            }

            function startTest (data) { socket.emit("start test", data); }
            soda.runner.on("start test", startTest);

            /**
             * Run a test/module/suite
             * @param  {object} request The client request object
             * @return {undefined}
             */
            function run (request) {
                var runObject = soda.runner.run(request.data, function (err, res, test, msg) {
                    soda.console.debug("Test/Module/Suite finished, emitting results for run with id:", request.data.runId);
                    if(err) {
                        socket.emit("run results " + request.data.runId, err);
                    }
                    else {
                        socket.emit("run results " + request.data.runId, {
                            results: res,
                            message: msg
                        });
                    }
                });

                runObject.on("allow", function (states) {
                    socket.emit("allow " + runObject.id, states);
                });

                runObject.on("current", function (action) { 
                    soda.console.debug("VisualEditor: emitting current with id:", runObject.id); 
                    socket.emit("current " + runObject.id, action); 
                });

                runObject.on("failed" , function () { 
                    soda.console.debug("VisualEditor: emitting failed with id:",  runObject.id); 
                    socket.emit("failed "  + runObject.id); 
                });

                runObject.on("paused" , function () { 
                    soda.console.debug("VisualEditor: emitting paused with id:",  runObject.id); 
                    socket.emit("paused "  + runObject.id); 
                });

                runObject.on("stopped", function () { 
                    soda.console.debug("VisualEditor: emitting stopped with id:", runObject.id); 
                    socket.emit("stopped " + runObject.id); 
                });
                
                runObject.on("running", function () { 
                    soda.console.debug("VisualEditor: emitting running with id:", runObject.id); 
                    socket.emit("running " + runObject.id); 
                });

                respondTo(request, {
                    started : Date.now(),
                    args    : request.data,
                    tid     : runObject.id
                });

            }

            /**
             * Returns the available devices for each framework
             * @param  {object} request The client request object
             * @return {undefined}
             */
            function getAvailableDevices (request) {
                if(request  && typeof request.data === "string") {
                    soda.framework.listAvailableDevices(request.data, function (devices) {
                        respondTo(request, devices);
                    });
                }
                else {
                    respondTo(request, new Error("Unable to get available devices, invalid arguments"));
                }
            }

            /**
             * Execute an action from the VisualEditor
             * @composes ActionManager
             * @param  {object} request The client request object
             * @return {undefined}
             */
            function execute (request) {
                if(typeof request.data === "object") {
                    var asset = new Asset(soda, "global", "global", soda.config.get("platform"), "VisualEditor Native Action", "VisualEditor"),
                        oldMode = soda.config.get("interactiveMode"),
                        action;

                    asset.setSyntax({ name: request.data.meta.syntax.name, version: request.data.meta.syntax.version });
                    asset.setContents(request.data);

                    soda.assets.get(soda.config.get("testPath"), function (err, collection) {
                        if(err) return respondTo(request, err);

                        asset.collection = collection;
                        action = new soda.Action(asset);

                        soda.config.set("interactiveMode", false);
                        action.evaluate(function (err, res, message) {
                            if(err) return respondTo(request, err);
                            respondTo(request, { result: res, message: message });
                            soda.config.set("interactiveMode", oldMode);
                        });
                    });
                }
                else {
                    respondTo(request, new Error("Malformed action object. The action to execute must be an object!"));
                }
            }

            // Pipe stdout to the client
            soda.console.on("log", pipeOutput);
            repl.console.on("log", pipeOutput);

            // Update config on config updates
            soda.config.on("config set", configUpdate);

            // Put soda out for garbage collection on disconnect
            socket.on('disconnect', function () {
                if(Collections[socket.id]) {
                    Collections[socket.id].removeListener("assets loaded", onAssetLoad);
                    delete Collections[socket.id];
                }

                if(Instance[socket.id]) {
                    Instance[socket.id].removeListener("exit", onceOnExit);
                    delete Instance[socket.id];
                }

                if(lastTree[socket.id]) delete lastTree[socket.id];

                repl.console.removeListener("log", pipeOutput);
                soda.console.removeListener("log", pipeOutput);
                soda.config.removeListener("config set", configUpdate);
                soda.runner.removeListener("start test", startTest);

                soda.console.debug("Socket with id: " + socket.id + "has disconnected.");
                if(!attached) {
                    if(sodaInstance.framework.started && server.status.connections === 0) {
                        sodaInstance.framework.stop(function () {
                            if(sodaInstance) sodaInstance.kill();
                            sodaInstance = soda = null;
                        });
                    }
                    else {
                        sodaInstance.kill();
                        sodaInstance = soda = null;
                    }
                }
            });

            // When the client sends a request
            socket.on("request", function (request) {
                switch(request.command) {

                    // Get the framework status
                    case "get status":
                        return getStatus(request);

                    case "encrypt":
                        if(typeof request.data === "string") {
                            respondTo(request, cypher.encrypt(request.data));
                        }
                        else {
                            return respondTo(request, new Error("Unable to encrypt, invalid arguments"));
                        }
                        break;

                    // Retrieve the user's favorites
                    case "get favorites":
                        return respondTo(request, userFavorites);

                    // Save the user's favorites
                    case "save favorites":
                        return saveUserFavorites(request.data, function (err) {
                            if(err) return respondTo(request, err);
                            respondTo(request, true);
                        });

                    // Retrieve the user's favorites
                    case "get settings":
                        return respondTo(request, userSettings);

                    // Save the user's favorites
                    case "save settings":
                        return saveUserSettings(request.data, function (err) {
                            if(err) return respondTo(request, err);
                            respondTo(request, true);
                        });

                    // Get the current Soda configuration
                    case "get config":
                        return getConfig(request);

                    // Update a Soda configuration variable
                    case "update config":
                        return updateConfig(request);

                    // Update a Soda configuration variable
                    case "get syntax":
                        return getSyntax(request);

                    // Get an updated screen shot
                    case "get latest screen":
                        return getScreenUpdate(request);

                    // Get an updated DOM
                    case "get latest tree":
                        return getTreeUpdate(request);

                    case "get available devices":
                        return getAvailableDevices(request);

                    // Start a framework
                    case "start framework":
                        return startFramework(request);

                    // Stop a framework
                    case "stop framework":
                        return stopFramework(request);

                    // Run a test/suite/module
                    case "run":
                        return run(request);

                    // Execute an individual action or list
                    case "execute":
                        return execute(request);

                    // Query the DOM Tree
                    case "query tree":
                        return queryTree(request);

                    // See if any file exists
                    case "base path":
                        if(typeof request.data === "string") {
                            respondTo(request, nodePath.dirname(request.data));
                        }
                        else {
                            return respondTo(request, new Error("Path must be a string!"));
                        }
                        break;

                    // See if any file exists
                    case "any file exists":
                        if(typeof request.data === "string") {
                            return fs.exists(request.data.replace(/~/g, soda.config.get("userHome").withoutTrailingSlash), function (exists) {
                                respondTo(request, exists);
                            });
                        }
                        else {
                            return respondTo(request, new Error("Path must be a string!"));
                        }
                        break;

                    // See if a file exists
                    case "asset exists":
                        if(typeof request.data          === "object" &&
                           typeof request.data.suite    === "string" &&
                           typeof request.data.module   === "string" &&
                           typeof request.data.name     === "string" &&
                           typeof request.data.platform === "string" &&
                           typeof request.data.type     === "string"
                        ) {
                            if(!request.data.accept) request.data.accept = { global: false, common: false, generic: false };
                            return Collections[socket.id].resolve(request.data, function (err, action, asset) {
                                respondTo(request, err ? false : (asset.type === request.data.type && asset.name === request.data.name));
                            });
                        }
                        else {
                            return respondTo(request, new Error("Unable to assert existence, invalid arguments!"));
                        }
                        break;

                    case "zip scripts":
                        var fs = require('fs');
                        var archiver = require('archiver');

                        // create a file to stream archive data to.
                        var output = fs.createWriteStream(nodePath.join(__dirname, "..", "..", "scripts.zip"));
                        var archive = archiver('zip', {
                          zlib: { level: 9 } // Sets the compression level.
                        });

                        // listen for all archive data to be written
                        // 'close' event is fired only when a file descriptor is involved
                        output.on('close', function() {
                          console.log(archive.pointer() + ' total bytes');
                          console.log('archiver has been finalized and the output file descriptor has closed.');

                          fs.readFile(nodePath.join(__dirname, "..", "..", "scripts.zip"), function (err, fc) {
                              if(err) return respondTo(request, err);

                              respondTo(request, fc.toString('base64') || null);
                          });
                        });

                        // This event is fired when the data source is drained no matter what was the data source.
                        // It is not part of this library but rather from the NodeJS Stream API.
                        // @see: https://nodejs.org/api/stream.html#stream_event_end
                        output.on('end', function() {
                          console.log('Data has been drained');
                        });

                        // good practice to catch warnings (ie stat failures and other non-blocking errors)
                        archive.on('warning', function(err) {
                          if (err.code === 'ENOENT') {
                            // log warning
                          } else {
                            // throw error
                            throw err;
                          }
                        });

                        // good practice to catch this error explicitly
                        archive.on('error', function(err) {
                          throw err;
                        });

                        // pipe archive data to the file
                        archive.pipe(output);

                        // append files from a sub-directory, putting its contents at the root of archive
                        archive.directory(request.data.directory, false);

                        // finalize the archive (ie we are done appending files but streams have to finish yet)
                        // 'close', 'end' or 'finish' may be fired right after calling this method so register to them beforehand
                        archive.finalize();

                        break;

                    // Write an asset
                    case "write asset":
                        if(typeof request.data          === "object" &&
                           typeof request.data.suite    === "string" &&
                           typeof request.data.module   === "string" &&
                           typeof request.data.name     === "string" &&
                           typeof request.data.platform === "string" &&
                           typeof request.data.type     === "string" &&
                           (typeof request.data.contents === "string" || typeof request.data.contents === "object")
                        ) {
                            return Collections[socket.id].makeAsset(request.data, function (err) {
                                respondTo(request, err);
                            });
                        }
                        else {
                            return respondTo(request, new Error("Unable to write asset, invalid arguments"));
                        }
                        break;

                    // Read an asset
                    case "read asset":
                    if(typeof request.data          === "object" &&
                       typeof request.data.suite    === "string" &&
                       typeof request.data.module   === "string" &&
                       typeof request.data.name     === "string" &&
                       typeof request.data.type     === "string" &&
                       typeof request.data.platform === "string"
                    ) {
                        request.data.accept = { global: false, common: false };
                        return Collections[socket.id].resolve(request.data, function (err, action, asset) {
                            if(err) return respondTo(request, err);
                            asset.getContents(function (err, contents) {
                                if(err) return respondTo(request, err);
                                respondTo(request, contents || {});
                            });
                        });
                    }
                    else {
                        return respondTo(request, new Error("Unable to resolve asset file, invalid arguments"));
                    }
                    break;

                    // Read an asset
                    case "load all assets":
                      soda.loadAssets(soda.config.get("testPath"), function (err, collection) {
                        if(err) return respondTo(request, err);

                        Collections[socket.id] = collection;
                        Collections[socket.id].on("assets loaded", onAssetLoad);

                        respondTo(request, {});
                      });
                    break;

                    // See if any directory exists
                    case "any directory exists":
                        if(typeof request.data === "string") {
                            return fs.stat(nodePath.normalize(request.data.replace(/~/g, soda.config.get("userHome").withoutTrailingSlash)), function (err) {
                                if(err && err.code !== "ENOENT") return respondTo(request, err);
                                respondTo(request, (err ? false : true));
                            });
                        }
                        else {
                            return respondTo(request, new Error("Unable to check for directory, invalid arguments"));
                        }
                        break;

                    // See if a suite exists
                    case "suite exists":
                        if(typeof request.data === "string") {
                            respondTo(request, !!Collections[socket.id].getSuite(request.data));
                        }
                        else {
                            return respondTo(request, new Error("Unable to verify suite existence, invalid arguments"));
                        }
                        break;

                    // See if a module exists
                    case "module exists":
                        if(typeof request.data === "object" && typeof request.data.suite === "string" && typeof request.data.module === "string") {
                            var s = Collections[socket.id].getSuite(request.data.suite);
                            if(s) {
                                respondTo(request, !!s.getModule(request.data.module));
                            }
                            else {
                                respondTo(request, false);
                            }
                        }
                        else {
                            return respondTo(request, new Error("Unable to verify module existence, invalid arguments"));
                        }
                        break;

                    // Make a module
                    case "make module":
                        if(typeof request.data === "object" && typeof request.data.suite === "string" && typeof request.data.module === "string") {
                            return Collections[socket.id].makeModule(request.data.suite, request.data.module, function (err) {
                                respondTo(request, err);
                            });
                        }
                        else {
                            return respondTo(request, new Error("Unable to make module, invalid arguments"));
                        }
                        break;

                    // Make a suite
                    case "make suite":
                        if(typeof request.data === "string") {
                            return Collections[socket.id].makeSuite(request.data, function (err) {
                                respondTo(request, err);
                            });
                        }
                        else {
                            return respondTo(request, new Error("Unable to make module, invalid arguments"));
                        }
                        break;

                    // Delete an asset
                    case "delete asset":
                        if(typeof request.data          === "object" &&
                           typeof request.data.suite    === "string" &&
                           typeof request.data.module   === "string" &&
                           typeof request.data.name     === "string" &&
                           typeof request.data.type     === "string" &&
                           typeof request.data.platform === "string"
                        ) {
                            return Collections[socket.id].deleteAsset(request.data, function (err) {
                                respondTo(request, err);
                            });
                        }
                        else if(typeof request.data          === "object" &&
                            typeof request.data.suite    === "string" &&
                            typeof request.data.module   === "string"
                        ) {
                            return Collections[socket.id].deleteModule(request.data.suite, request.data.module, function (err) {
                                respondTo(request, err);
                            });
                        }
                        else if(typeof request.data          === "object" &&
                           typeof request.data.suite    === "string"
                        ) {
                            return Collections[socket.id].deleteSuite(request.data.suite, function (err) {
                                respondTo(request, err);
                            });
                        }
                        else {
                            return respondTo(request, new Error("Unable to delete asset, invalid arguments"));
                        }
                        break;

                    // Stop the current framework
                    case "shutdown":
                        return soda.framework.stop(function () {
                            respondTo(request, true);
                            if(repl.isStarted) repl.kill();
                            soda.assets.destroy();
                            server.stop();
                        });

                    // Build a project
                    case "build":
                        if(request.data instanceof Array) {
                            request.data.sodaeach(function (d, k, i, p) {
                                p[k] = d.replace(/~/g, soda.config.get("userHome").withoutTrailingSlash);
                            });
                            request.data.push(function (built) {
                                respondTo(request, built);
                            });

                            var dataToSend = request.data;

                            if (request.data.framework === "instruments") {
                                  dataToSend = [];
                                  dataToSend.push(request.data.device);
                                  dataToSend.push(request.data.target);
                                  dataToSend.push(request.data.workspace);
                                  dataToSend.push(request.data.buildpath);
                                  dataToSend.push(request.data.app);
                                  dataToSend.push(request.data.bundleid);
                                  dataToSend.push(function (built) {
                                    respondTo(request, built);
                                  });
                            }

                            if (request.data.framework === "perfecto") {
                                  dataToSend = [];
                                  dataToSend.push(request.data.deviceid);
                                  dataToSend.push(request.data.target);
                                  dataToSend.push(request.data.workspace);
                                  dataToSend.push(request.data.buildpath);
                                  dataToSend.push(request.data.app);
                                  dataToSend.push(function (built) {
                                    respondTo(request, built);
                                  });
                            }

                            return soda.framework.build.apply(soda.framework, dataToSend);
                        }
                        else {
                            return respondTo(request, new Error("Unable to build app, invalid arguments"));
                        }
                        break;

                    // Build a project
                    case "prebuild":
                        if(request.data instanceof Array) {
                            var env = request.data.shift(),
                                fname = request.data.shift();

                            soda.config.set("env", env);

                            soda.framework.load(fname);

                            request.data.sodaeach(function (d, k, i, p) {
                                if(typeof p[k] === "string") p[k] = d.replace(/~/g, soda.config.get("userHome").withoutTrailingSlash);
                            });

                            request.data.push(function (built) {
                                respondTo(request, built);
                            });

                            return soda.framework.build.apply(soda.framework, request.data);
                        }
                        else {
                            return respondTo(request, new Error("Unable to build app, invalid arguments"));
                        }
                        break;

                    // Kill the process
                    case "kill":
                        return process.exit(1);

                    // Used for "interactive test" keypresses
                    case "keypress":
                        soda.console.debug("Client has emitted keypress:", request.data);
                        process.stdin.emit("keypress", null, { name: request.data });
                        return respondTo(request, true);

                    // Get the project's assets
                    case "get project hierarchy":
                        if(Collections[socket.id]) {
                            return respondTo(request, Collections[socket.id].getHierarchy());
                        }
                        else {
                            return soda.assets.get(function (err, collection) {
                                if(err) return respondTo(request, err);
                                if(Collections[socket.id] !== collection) {
                                    Collections[socket.id] = collection;
                                    Collections[socket.id].on("assets loaded", onAssetLoad);
                                }
                                return respondTo(request, Collections[socket.id].getHierarchy());
                            });
                        }
                        break;

                    // Execute a REPL command
                    case "execute command":
                        try {
                            repl.rl.emit("line", request.data);
                            respondTo(request, { executed: true });
                        }
                        catch(e) {
                            return respondTo(request, e);
                        }
                        break;

                    default:
                        respondTo(request, new Error("Unknown command event `" + request.command + "`"));
                }
            });

            if(done instanceof Function) done.call(soda, err);
        }

        ///////////////////////////////////////////////// CONSTRUCTOR //////////////////////////////////////////////////

        if(!(sodaToAttach && typeof sodaToAttach === "object" && typeof sodaToAttach.yid === "number")) {

            /**
             * @composes Soda
             */
            sodaInstance = new Soda({
              proxy: process.env.HTTP_PROXY ? process.env.HTTP_PROXY : process.env.http_proxy
            }).init(onSoda);
        }
        else if(sodaToAttach.initialized === false) {
            attached = true;
            sodaInstance = sodaToAttach;
            sodaToAttach.on("soda initialized", onSoda);

            if(sodaToAttach.framework.process && sodaToAttach.framework.process.on instanceof Function) {
                Instance[socket.id] = sodaToAttach.framework.process;
                Instance[socket.id].on("exit", onceOnExit);
            }
        }
        else {
            attached = true;
            sodaInstance = sodaToAttach;
            onSoda(null, sodaToAttach);

            if(sodaToAttach.framework.process && sodaToAttach.framework.process.on instanceof Function) {
                Instance[socket.id] = sodaToAttach.framework.process;
                Instance[socket.id].on("exit", onceOnExit);
            }
        }
    };
}

module.exports = VisualEditorEvents;
