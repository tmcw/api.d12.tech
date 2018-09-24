const path = require("path");
const sander = require("sander");
const child_process = require("child_process");
const tar = require("tar");
const got = require("got");
const d11n = require("d11n");

const { npmInstallEnvVars, root, tmpdir } = require("../../config.js");

process.on("message", message => {
  if (message.type === "start") {
    createBundle(message.params);
  }
});

process.send("ready");

async function createBundle({ hash, pkg, version, deep, query }) {
  const dir = `${tmpdir}/${hash}`;
  const cwd = `${dir}/package`;

  try {
    await sander.mkdir(dir);
    await fetchAndExtract(pkg, version, dir);
    await sanitizePkg(cwd);
    await installDependencies(cwd);

    const docs = await bundle(cwd, deep, query);

    process.send({
      type: "result",
      code: JSON.stringify(Array.from(docs.entries()))
    });
  } catch (err) {
    process.send({
      type: "error",
      message: err.message,
      stack: err.stack
    });
  }

  sander.rimraf(dir);
}

function fetchAndExtract(pkg, version, dir) {
  const tarUrl = pkg.versions[version].dist.tarball;

  info(`[${pkg.name}] fetching ${tarUrl}`);

  return new Promise((fulfil, reject) => {
    let timedout = false;

    const timeout = setTimeout(() => {
      reject(new Error("Request timed out"));
      timedout = true;
    }, 10000);

    const input = got(tarUrl, { stream: true });

    // don't like going via the filesystem, but piping into targz
    // was failing for some weird reason
    const intermediate = sander.createWriteStream(`${dir}/package.tgz`);

    input.pipe(intermediate);

    intermediate.on("close", () => {
      clearTimeout(timeout);

      if (!timedout) {
        info(`[${pkg.name}] extracting to ${dir}/package`);

        tar
          .x({
            file: `${dir}/package.tgz`,
            cwd: dir
          })
          .then(fulfil, reject);
      }
    });
  });
}

function sanitizePkg(cwd) {
  const pkg = require(`${cwd}/package.json`);
  pkg.scripts = {};
  return sander.writeFile(
    `${cwd}/package.json`,
    JSON.stringify(pkg, null, "  ")
  );
}

async function installDependencies(cwd) {
  const pkg = require(`${cwd}/package.json`);

  const envVariables = npmInstallEnvVars.join(" ");
  const installCommand = `${envVariables} ${root}/node_modules/.bin/npm install --production`;

  info(`[${pkg.name}] running ${installCommand}`);

  await exec(installCommand, cwd, pkg);
  if (!pkg.peerDependencies) return;

  return Object.keys(pkg.peerDependencies).reduce((promise, name) => {
    return promise.then(() => {
      info(`[${pkg.name}] installing peer dependency ${name}`);
      const version = pkg.peerDependencies[name];
      return exec(
        `${root}/node_modules/.bin/npm install "${name}@${version}"`,
        cwd,
        pkg
      );
    });
  }, Promise.resolve());
}

function bundle(cwd, deep, query) {
  const pkg = require(`${cwd}/package.json`);

  const entry = deep
    ? path.resolve(cwd, deep)
    : findEntry(
        path.resolve(
          cwd,
          pkg.source ||
            pkg.module ||
            pkg["jsnext:main"] ||
            pkg.main ||
            "index.js"
        )
      );

  return d11n(path.resolve(cwd, entry));
}

function findEntry(file) {
  try {
    const stats = sander.statSync(file);
    if (stats.isDirectory()) return `${file}/index.js`;
    return file;
  } catch (err) {
    return `${file}.js`;
  }
}

function exec(cmd, cwd, pkg) {
  return new Promise((fulfil, reject) => {
    child_process.exec(cmd, { cwd }, (err, stdout, stderr) => {
      if (err) {
        return reject(err);
      }

      stdout.split("\n").forEach(line => {
        info(`[${pkg.name}] ${line}`);
      });

      stderr.split("\n").forEach(line => {
        info(`[${pkg.name}] ${line}`);
      });

      fulfil();
    });
  });
}

function info(message) {
  process.send({
    type: "info",
    message
  });
}
