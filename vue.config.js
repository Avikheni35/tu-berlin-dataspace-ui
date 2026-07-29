module.exports = {
  "transpileDependencies": [
    "vuetify"
  ],
  devServer: {
    allowedHosts: "all",
  },
  pages: {
    index: {
      entry: "src/main.js",
      title: "TU Berlin Dataspace Connector"
    }
  }
}