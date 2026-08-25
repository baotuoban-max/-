(function installUiPreviewShim() {
  if (location.protocol === 'chrome-extension:') return;

  var emptyEvent = {addListener:function(){}, removeListener:function(){}};
  var localStore = {};
  var slowTaskPreview = new URLSearchParams(location.search).has('running-preview');
  var runtime = globalThis.chrome || {};
  runtime.tabs = {
    query:function(_query, callback) {
      callback([{id:1, url:'https://fxali.dgjapp.com/Common/Page/Purchases-Index'}]);
    },
    create:function(){},
    update:function(){}
  };
  runtime.storage = {
    local:{
      get:function(keys, callback) {
        var result = {};
        var list = Array.isArray(keys) ? keys : [keys];
        list.forEach(function(key) {
          if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(localStore, key)) {
            result[key] = localStore[key];
          }
        });
        callback(result);
      },
      set:function(values, callback) {
        Object.assign(localStore, values || {});
        if (callback) callback();
      }
    }
  };
  runtime.runtime = {
    lastError:null,
    onMessage:emptyEvent,
    sendMessage:function(_message, callback) { if (callback) callback({ok:true}); }
  };
  runtime.scripting = {
    executeScript:function() {
      return new Promise(function(resolve) {
        setTimeout(function() { resolve([{result:{}}]); }, slowTaskPreview ? 7000 : 0);
      });
    }
  };
  globalThis.chrome = runtime;

  globalThis.fetch = function() {
    return Promise.resolve({
      ok:true,
      json:function() {
        return Promise.resolve({
          code:0,
          tenant_access_token:'ui-preview',
          expire:7200,
          data:{items:[], has_more:false, total:0}
        });
      }
    });
  };
})();
