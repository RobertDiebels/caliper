const Express = require('express');
const app = Express();
const port = 3000;

process.env.HFC_LOGGING = '{"debug":"console","info":"console","error": "console"}';

app.use('/caliper/reports', Express.static('reports'));

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


app.listen(port, (err) => {
    if (err) {
        return console.log('Error while listening to :', err);
    }

    console.log(`server is listening on ${port}`);
});
