const provider = require('./provider');

module.exports = {
  complete: (model, messages, opts) => provider.complete(model, messages, opts),
};
