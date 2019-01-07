const Path = require('path');
const Express = require('express');
const TarGz = require('targz');
const Fs = require('fs-extra');
const FabricUtils = require('fabric-client/lib/utils');
const app = Express();

const port = 3000;
global.status = 'idle';
global.roundStatus = {
    name: 'unknown',
    status: 'idle',
    transactions: {
        submitted: 0,
        succeeded: 0,
        failed: 0,
        unfinished: 0
    }
};

//Dirty hack to silence Fabric logger...
process.env.HFC_LOGGING = '{"error":"console"}';
FabricUtils.getLogger();
if (global.hfc && global.hfc.logger && global.hfc.logger.transports) {
    for (let transport in global.hfc.logger.transports) {
        if (global.hfc.logger.transports.hasOwnProperty(transport)) {
            const transportLogger = global.hfc.logger.transports[transport];
            transportLogger.silent = true;
        }
    }
}
const downloadPath = Path.posix.join(Path.posix.sep, 'caliper', 'data', 'downloads');
Fs.ensureDirSync(downloadPath);
app.use('/reports', Express.static(Path.join(Path.sep, 'caliper', 'reports')));
app.use('/data/dumps', Express.static(Path.join(Path.sep, 'caliper', 'data', 'dumps')));

app.get('/', (request, response) => {
    response.send('Ready for requests!');
});

app.get('/start', (request, response) => {
    response.send('Starting');
    try {
        const main = require('../benchmark/callbacks/main.js');
        main();
    }
    catch (e) {
        global.status = 'error';
    }

});

app.get('/stop', (request, response) => {
    response.send('Stopping');
});

app.get('/data/download', (request, response) => {
    const filename = `test-results-${new Date(Date.now()).toISOString()}.tar.gz`;
    const path = Path.join(downloadPath, filename);
    TarGz.compress({
        src: Path.join(Path.sep, 'caliper', 'data', 'dumps'),
        dest: path
    }, function (err) {
        if (err) {
            console.log(err);
        } else {
            response.download(path, filename);
        }
    });
});

app.get('/status', (request, response) => {
    response.send(global.status);
});

app.get('/round/status', (request, response) => {
    response.send(global.roundStatus);
});


// compress files into tar.gz archive

app.listen(port, (err) => {
    if (err) {
        return console.log('Error while listening to :', err);
    }

    console.log(`server is listening on ${port}`);
});
