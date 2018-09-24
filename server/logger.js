module.exports = {
  log(msg) {
    console.log(`${(new Date()).toISOString()} ${msg}`);
  }
  info(msg) {
    console.log(`${(new Date()).toISOString()} ${msg}`);
  }
};
