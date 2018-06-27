/*
* This file exists only to call the benchmarks main.js file. This file is mounted by Kubernetes into the Caliper container as a sym-link.
* In version 8.x of NodeJS sym-links aren't preserved by default and it does not preserve symlinks for the require.main file at all.
* This causes relative paths to break if when requiring javascript files that have been mounted into the container.
*
* For instance, the following file: `main.js` is mounted in the caliper container as a ConfigMap by Kubernetes in the directory: /caliper/benchmark/callbacks/main.js
* Kubernetes than creates a sym-link from that path to the following one: caliper/benchmark/callbacks/..2018_06_04_19_31_41.860238952/main.js
* So the actual path of the file is: 'caliper/benchmark/callbacks/..2018_06_04_19_31_41.860238952/main.js'
*
* This can cause relative requiring to break. Since main.js might require: '../query.js'
* That file does not exist in the directory: '..2018_06_04_19_31_41.860238952' and it will break NodeJS if Sym-links are de-referenced.
*
* This prevents us from using 'node main.js'. As require.main file will always be de-referenced (aka the actual file-system path will be used).
* Which may break code which uses a relative path in a require statement.
*
* To circumvent this issue NodeJS is called with the --perserve-symlinks flag in the npm start command
* and it starts NodeJS with this file as it's require.main allowing relative paths to work properly (see package.json).
* */
const main = require('../benchmark/callbacks/main.js');
main();