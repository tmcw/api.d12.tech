const { fork } = require("child_process");
const sander = require("sander");
const semver = require("semver");
const zlib = require("zlib");
const get = require("./utils/get.js");
const findVersion = require("./utils/findVersion.js");
const cache = require("./cache.js");
const etag = require("etag");
const crypto = require("crypto");

const { sendBadRequest, sendError } = require("./utils/responses.js");
const { root, registry, additionalBundleResHeaders } = require("../config.js");

function stringify(query) {
  const str = Object.keys(query)
    .sort()
    .map(key => `${key}=${query[key]}`)
    .join("&");
  return str ? `?${str}` : "";
}

module.exports = function servePackage(req, res, next) {
  if (req.method !== "GET") return next();

  const match = /^\/(?:@([^\/]+)\/)?([^@\/]+)(?:@(.+?))?(?:\/(.+?))?(?:\?(.+))?$/.exec(
    req.url
  );

  if (!match) {
    // TODO make this prettier
    return sendBadRequest(res, "Invalid module ID");
  }

  const user = match[1];
  const id = match[2];
  const tag = match[3] || "latest";
  const deep = match[4];
  const queryString = match[5];

  const qualified = user ? `@${user}/${id}` : id;
  const query = (queryString || "").split("&").reduce((query, pair) => {
    if (!pair) return query;

    const [key, value] = pair.split("=");
    query[key] = value || true;
    return query;
  }, {});

  get(`${registry}/${encodeURIComponent(qualified).replace("%40", "@")}`)
    .then(JSON.parse)
    .then(meta => {
      if (!meta.versions) {
        console.error(`[${qualified}] invalid module`);

        return sendBadRequest(res, "invalid module");
      }

      const version = findVersion(meta, tag);

      if (!semver.valid(version)) {
        console.error(`[${qualified}] invalid tag`);

        return sendBadRequest(res, "invalid tag");
      }

      if (version !== tag) {
        let url = `/${meta.name}@${version}`;
        if (deep) url += `/${deep}`;
        url += stringify(query);

        res.redirect(302, url);
        return;
      }

      return fetchBundle(meta, tag, deep, query).then(zipped => {
        console.info(`[${qualified}] serving ${zipped.length} bytes`);
        res.status(200);
        res.set(
          Object.assign(
            {
              "Content-Length": zipped.length,
              "Content-Type": "application/javascript; charset=utf-8",
              "Content-Encoding": "gzip"
            },
            additionalBundleResHeaders
          )
        );

        // FIXME(sven): calculate the etag based on the original content
        res.setHeader("ETag", etag(zipped));
        res.end(zipped);
      });
    })
    .catch(err => {
      console.error(`[${qualified}] ${err.message}`, err.stack);
      const page = sander
        .readFileSync(`${root}/server/templates/500.html`, {
          encoding: "utf-8"
        })
        .replace("__ERROR__", err.message);

      sendError(res, page);
    });
};

const inProgress = {};

function fetchBundle(pkg, version, deep, query) {
  let hash = `${pkg.name}@${version}`;
  if (deep) hash += `_${deep.replace(/\//g, "_")}`;
  hash += stringify(query);

  console.info(`[${pkg.name}] requested package`);

  hash = crypto
    .createHash("sha1")
    .update(hash)
    .digest("hex");

  if (cache.has(hash)) {
    console.info(`[${pkg.name}] is cached`);
    return Promise.resolve(cache.get(hash));
  }

  if (inProgress[hash]) {
    console.info(`[${pkg.name}] request was already in progress`);
  } else {
    console.info(`[${pkg.name}] is not cached`);

    inProgress[hash] = createBundle(hash, pkg, version, deep, query)
      .then(
        result => {
          console.log(result);
          const zipped = zlib.gzipSync(result);
          cache.set(hash, zipped);
          return zipped;
        },
        err => {
          inProgress[hash] = null;
          throw err;
        }
      )
      .then(zipped => {
        inProgress[hash] = null;
        return zipped;
      });
  }

  return inProgress[hash];
}

function createBundle(hash, pkg, version, deep, query) {
  return new Promise((fulfil, reject) => {
    const child = fork("server/child-processes/create-bundle.js");

    child.on("message", message => {
      if (message === "ready") {
        child.send({
          type: "start",
          params: { hash, pkg, version, deep, query }
        });
      }

      if (message.type === "info") {
        console.info(message.message);
      } else if (message.type === "error") {
        const error = new Error(message.message);
        error.stack = message.stack;

        reject(error);
        child.kill();
      } else if (message.type === "result") {
        fulfil(message.code);
        child.kill();
      }
    });
  });
}
