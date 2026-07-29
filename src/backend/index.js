import 'dotenv/config'
import express from "express";
import cors from "cors";
import axios from "axios";
import https from "https";
import bodyParser from "body-parser";
import path from "path";
import ontologyLoader from "./ontologyLoader.js"
import basicAuth from "express-basic-auth";
import { TextDecoder } from "util";

const vuePath = path.join(path.resolve(),'..', '..', 'dist');
const app = express();
const port = 8083;

let DEBUG = false;
let connectorUrl = "https://localhost:8080"
let auth = {
    username: 'admin',
    password: 'password'
}
let httpsAgent = new https.Agent({
    maxVersion: "TLSv1.2",
    minVersion: "TLSv1.2",
    rejectUnauthorized: false
    //ca: fs.readFileSync('dsc.crt')
});

let basicAuthUser = process.env.BASIC_AUTH_USER || '';
let basicAuthPassword = process.env.BASIC_AUTH_PASSWORD || '';

if (process.env.USE_ONTOLOGY !== undefined && process.env.USE_ONTOLOGY === "true") {
    ontologyLoader.loadOntology();
}

if (process.env.CONNECTOR_URL !== undefined) {
    connectorUrl = process.env.CONNECTOR_URL;
}

if (process.env.DEBUG !== undefined) {
    DEBUG = process.env.DEBUG === "true";
}

if (process.env.CONNECTOR_USER !== undefined) {
    auth.username = process.env.CONNECTOR_USER;
}

if (process.env.CONNECTOR_PASSWORD !== undefined) {
    auth.password = process.env.CONNECTOR_PASSWORD;
}

// initialize health before basicAuth to allow access without authentication
app.use('/health', function (req, res) {
    res.end('OK')
});

// require basicauth implicitly if user and pass are set via env to strings with length > 0
if(typeof basicAuthUser === 'string' && basicAuthUser.length > 0
    && typeof basicAuthPassword === 'string' && basicAuthPassword.length > 0) {
    console.log('Enabling basic authentication');

    let basicAuthOptions = {
        users: {},
        challenge: true
    };

    basicAuthOptions.users[basicAuthUser] = basicAuthPassword;
    app.use(basicAuth(basicAuthOptions));
}

app.use(express.static(vuePath));
app.use(cors({ credentials: true, origin: true }));
app.use(bodyParser.urlencoded({
    extended: true,
    limit: '4096mb'
}));
app.use(bodyParser.json({limit: '4096mb'}));

function post(url, data) {
    if (DEBUG === true) {
        console.log(">>> POST " + url);
        console.log(">>> DATA: ", data);
    }
    return axios.post(url, data, {
        headers: { 'content-type': 'application/json' },
        auth,
        httpsAgent
    });
}

function put(url, data) {
    if (DEBUG === true) {
        console.log(">>> PUT " + url);
        console.log(">>> DATA: ", data);
    }
    return axios.put(url, data, {
        headers: { 'content-type': 'application/json' },
        auth,
        httpsAgent
    });
}

function get(url) {
    if (DEBUG === true) {
        console.log(">>> GET " + url);
    }
    return axios.get(url, {
        headers: { 'content-type': 'application/json' },
        auth,
        httpsAgent
    });
}

function del(url, data) {
    if (DEBUG === true) {
        console.log(">>> DELETE " + url);
        console.log(">>> DATA: ", data);
    }
    return axios.delete(url, {
        data: data,
        headers: { 'content-type': 'application/json' },
        auth,
        httpsAgent
    });
}

function getBinary(url) {
    if (DEBUG === true) {
        console.log(">>> GET (binary) " + url);
    }
    return axios.get(url, {
        auth,
        httpsAgent,
        responseType: 'arraybuffer'
    });
}

// The connector's artifact data occasionally comes back double-encoded: raw
// bytes get read upstream as Latin-1 and re-serialized as UTF-8, so every
// byte >= 0x80 turns into a 2-byte UTF-8 sequence. This reverses that exact
// transform (decode UTF-8, re-encode Latin-1) only when it's safe to do so -
// i.e. the payload is valid UTF-8 and every decoded code point fits in a
// single Latin-1 byte. Genuine multi-byte UTF-8 text (real non-Latin-1
// characters) fails that check and is passed through untouched. Content
// that is genuine UTF-8 text using only Latin-1-range characters (e.g. "café")
// is indistinguishable from this corruption and would be altered - the same
// ambiguity the manual recover_file.py script has.
function recoverIfDoubleEncoded(buffer) {
    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (e) {
        return buffer;
    }
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) > 0xFF) {
            return buffer;
        }
    }
    return Buffer.from(text, 'latin1');
}

function escape(text, key) {
    let escapedText = "";
    if (Array.isArray(text)) {
        for (let i = 0; i < text.length; i++) {
            if (i > 0) {
                escapedText += "&" + key + "=";
            }
            escapedText += encodeURIComponent(text[i]);
        }
    } else {
        escapedText = encodeURIComponent(text);
    }
    return escapedText;
}

function stringifySafe(obj, replacer, spaces, cycleReplacer) {
    return JSON.stringify(obj, serializer(replacer, cycleReplacer), spaces)
}

function filterError(origError) {
    if (origError.response !== undefined) {
        // remove config & request data, because it contains sensitive data.
        origError.response.config = null;
        origError.response.request = null;
    }
    return origError;
}

function serializer(replacer, cycleReplacer) {
    var stack = [], keys = []

    if (cycleReplacer == null) cycleReplacer = function (key, value) {
        if (stack[0] === value) return "[Circular ~]"
        return "[Circular ~." + keys.slice(0, stack.indexOf(value)).join(".") + "]"
    }

    return function (key, value) {
        if (stack.length > 0) {
            var thisPos = stack.indexOf(this)
            ~thisPos ? stack.splice(thisPos + 1) : stack.push(this)
            ~thisPos ? keys.splice(thisPos, Infinity, key) : keys.push(key)
            if (~stack.indexOf(value)) value = cycleReplacer.call(this, key, value)
        }
        else stack.push(value)

        return replacer == null ? value : replacer.call(this, key, value)
    }
}

app.get('/ontology', function (req, res) {
    res.send(ontologyLoader.getOntology());
});

app.get('/testdata', function (req, res) {
    res.send("TEST DATA FROM BACKEND");
});

// Fetches artifact data as raw bytes and streams it back with a download
// content-type/disposition, so the browser never interprets binary payloads
// as text (which caused re-encoding corruption when linking to the connector
// directly).
app.get('/download', function (req, res) {
    let call = req.query.url;
    if (typeof call !== "string" || !call.startsWith("/")) {
        res.status(400).send("Invalid url");
        return;
    }
    getBinary(connectorUrl + call).then(response => {
        let data = recoverIfDoubleEncoded(Buffer.from(response.data));
        res.set('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        res.set('Content-Disposition', response.headers['content-disposition'] || 'attachment');
        res.send(data);
    }).catch(origError => {
        let error = filterError(origError);
        console.log("Error on GET (download) " + call, stringifySafe(error.response || error));
        res.status(502).send("Error fetching artifact data");
    });
});

app.post('/testdata', function (req, res) {
    console.log(">>> TEST DATA RECEIVED: ", req.body);
    res.send("OK");
});

app.get('/', function (req, res) {
    res.sendFile(path.join(vuePath, "index.html"));
});

app.post('/', (req, res) => {
    let call = req.body.url;
    let i = 0;
    for (let key in req.body.params) {
        if (i === 0) {
            call += "?" + key + "=" + escape(req.body.params[key], key);
        } else {
            call += "&" + key + "=" + escape(req.body.params[key], key);
        }
        i++;
    }
    if (req.body.type == "POST") {
        post(connectorUrl + call, req.body.body).then(response => {
            res.send(response.data);
        }).catch(origError => {
            let error = filterError(origError);
            if (error.response === undefined) {
                console.log("Error on POST " + req.body.url, error);
                res.send(stringifySafe(error));
            } else {
                console.log("Error on POST " + req.body.url, stringifySafe(error.response));
                res.send(stringifySafe(error.response));
            }

        });
    } else if (req.body.type == "PUT") {
        put(connectorUrl + call, req.body.body).then(response => {
            res.send(response.data);
        }).catch(origError => {
            let error = filterError(origError);
            if (error.response === undefined) {
                console.log("Error on PUT " + req.body.url, error);
                res.send(stringifySafe(error));
            } else {
                console.log("Error on PUT " + req.body.url, stringifySafe(error.response));
                res.send(stringifySafe(error.response));
            }
        });
    } else if (req.body.type == "GET") {
        if (call == "/connector/address") {
            res.send(connectorUrl);
        } else {
            get(connectorUrl + call).then(response => {
                res.send(response.data);
            }).catch(origError => {
                let error = filterError(origError);
                if (error.response === undefined) {
                    console.log("Error on GET " + req.body.url, error);
                    res.send(stringifySafe(error));
                } else {
                    console.log("Error on GET " + req.body.url, stringifySafe(error.response));
                    res.send(stringifySafe(error.response));
                }
            });
        }
    } else if (req.body.type == "DELETE") {
        del(connectorUrl + call, req.body.body).then(response => {
            res.send(response.data);
        }).catch(origError => {
            let error = filterError(origError);
            if (error.response === undefined) {
                console.log("Error on DELETE " + req.body.url, error);
                res.send(stringifySafe(error));
            } else {
                console.log("Error on DELETE " + req.body.url, stringifySafe(error.response));
                res.send(stringifySafe(error.response));
            }
        });
    }
});

app.listen(port, () => {
    console.log(`Backend listening at http://localhost:${port}`)
});
