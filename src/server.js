const Path = require('path');
const Express = require('express');
const TarGz = require('targz');
const Fs = require('fs-extra');
const app = Express();

const port = 3000;

// process.env.HFC_LOGGING = '{"debug":"console","info":"console","error": "console"}';
const downloadPath = Path.posix.join(Path.posix.sep, 'caliper', 'data', 'downloads');
Fs.ensureDirSync(downloadPath);
app.use('/reports', Express.static(Path.join(Path.sep, 'caliper', 'reports')));
app.use('/data/dumps', Express.static(Path.join(Path.sep, 'caliper', 'data','dumps')));

app.get('/', (request, response) => {
    response.send('Ready for requests!');
});

app.get('/start', (request, response) => {
    response.send('Starting');
    const main = require('../benchmark/callbacks/main.js');
    main();
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
    }, function(err){
        if(err) {
            console.log(err);
        } else {
            response.download(path, filename);
        }
    });
});

// compress files into tar.gz archive

app.listen(port, (err) => {
    if (err) {
        return console.log('Error while listening to :', err);
    }

    console.log(`server is listening on ${port}`);
});
