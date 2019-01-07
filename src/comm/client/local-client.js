/**
 * Copyright 2017 HUAWEI. All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 */

'use strict';

// global variables
const FabricUtils = require('fabric-client/lib/utils');
process.env.HFC_LOGGING = '{"error":"console"}';
FabricUtils.getLogger();
//Dirty hack to silence Fabric logger...
if (global.hfc && global.hfc.logger && global.hfc.logger.transports) {
    for (let transport in global.hfc.logger.transports) {
        if (global.hfc.logger.transports.hasOwnProperty(transport)) {
            const transportLogger = global.hfc.logger.transports[transport];
            transportLogger.silent = true;
        }
    }
}

const bc = require('../blockchain.js');
const RateControl = require('../rate-control/rateControl.js');
const Util = require('../util.js');
const log = Util.log;

let blockchain;
let amountOfSubmittedTransactions = 0;
let sentTransactions = [];
let transactionResults = [];
let amountOfTransactionsToSent = 0;
let txLastNum = 0;
let txUpdateTail = 0;
let txUpdateTime = 10000;
let txSucceeded = 0;
let txFailed = 0;

/**
 * Calculate realtime transaction statistics and send the txUpdated message
 */
function txUpdate() {
    let newNum = amountOfSubmittedTransactions - txLastNum;
    txLastNum += newNum;

    let newResults = transactionResults.slice(txUpdateTail);
    txUpdateTail += newResults.length;
    if (newResults.length === 0 && newNum === 0) {
        return;
    }

    newResults.forEach((result) => {
        if (result.status === 'success') {
            txSucceeded++;
        }
        else if (result.status === 'failed') {
            txFailed++;
        }
    });
    console.log(`[Transactions] \n Total to sent - ${amountOfTransactionsToSent} \n Submitted - ${amountOfSubmittedTransactions} \n Finished - ${transactionResults.length} \n Transactions remaining - ${amountOfTransactionsToSent - transactionResults.length} \n Failed - ${txFailed} \n Succeeded - ${txSucceeded}`);
    // process.send({type: 'txUpdated', data: {submitted: newNum, committed: {succ: succ, fail: fail}}});
}

/**
 * Add new test result into global array
 * @param {Object} result test result, should be an array or a single JSON object
 */
function addResult(result) {
    if (Array.isArray(result)) { // contain multiple results
        for (let i = 0; i < result.length; i++) {
            transactionResults.push(result[i]);
        }
    }
    else {
        transactionResults.push(result);
    }
}

/**
 * Call before starting a new test
 */
function beforeTest() {
    transactionResults = [];
    amountOfSubmittedTransactions = 0;
    txUpdateTail = 0;
    txLastNum = 0;
}

/**
 * Callback for new submitted transaction(s)
 * @param {Number} count count of new submitted transaction(s)
 */
function submitCallback(count) {
    amountOfSubmittedTransactions += count;
}

/**
 * Perform test with specified number of transactions
 * @param {JSON} msg start test message
 * @param {Object} cb callback module
 * @param {Object} context blockchain context
 * @return {Promise} promise object
 */
async function runFixedNumber(msg, cb, context) {
    log('Info: client ' + process.pid + ' start test runFixedNumber()' + (cb.info ? (':' + cb.info) : ''));
    let rateControl = new RateControl(msg.rateControl, blockchain);
    rateControl.init(msg);

    await cb.init(blockchain, context, msg.args);
    const start = Date.now();

    console.log('Started submitting');
    while (amountOfSubmittedTransactions < msg.numb) {
        sentTransactions.push(cb.run().then((invokeStatus) => {
            addResult(invokeStatus);
            return Promise.resolve();
        }).catch((e) => {
            console.error('Error running callback:', e);
        }));
        await rateControl.applyRateControl(start, amountOfSubmittedTransactions, transactionResults);
    }
    console.log('Finished submitting');
    await Promise.all(sentTransactions);
    console.log('All transactions committed');
    await rateControl.end();
    console.log('Releasing context');
    return await blockchain.releaseContext(context);
}

/**
 * Perform test with specified test duration
 * @param {JSON} msg start test message
 * @param {Object} cb callback module
 * @param {Object} context blockchain context
 * @return {Promise} promise object
 */
async function runDuration(msg, cb, context) {
    log('Info: client ' + process.pid + ' start test runDuration()' + (cb.info ? (':' + cb.info) : ''));
    let rateControl = new RateControl(msg.rateControl, blockchain);
    rateControl.init(msg);
    const duration = msg.txDuration; // duration in seconds

    await cb.init(blockchain, context, msg.args);
    const start = Date.now();

    let promises = [];
    while ((Date.now() - start) / 1000 < duration) {
        promises.push(cb.run().then((result) => {
            addResult(result);
            return Promise.resolve();
        }));
        await rateControl.applyRateControl(start, amountOfSubmittedTransactions, transactionResults);
    }

    await Promise.all(promises);
    await rateControl.end();
    return await blockchain.releaseContext(context);
}


/**
 * Perform the test
 * @param {JSON} msg start test message
 * @return {Promise} promise object
 */
function doTest(msg) {
    log('doTest() with:', msg);
    let cb = require(msg.cb);
    blockchain = new bc(msg.config);

    beforeTest();
    // start an interval to report results repeatedly
    amountOfTransactionsToSent = msg.numb;
    let txUpdateInter = setInterval(txUpdate, txUpdateTime);
    /**
     * Clear the update interval
     */
    let clearUpdateInter = function () {
        // stop reporter
        if (txUpdateInter) {
            clearInterval(txUpdateInter);
            txUpdateInter = null;
            txUpdate();
        }
    };

    return blockchain.getContext(msg.label, msg.clientargs).then((context) => {
        if (typeof context === 'undefined') {
            context = {
                engine: {
                    submitCallback: submitCallback
                }
            };
        }
        else {
            context.engine = {
                submitCallback: submitCallback
            };
        }
        if (msg.txDuration) {
            return runDuration(msg, cb, context);
        } else {
            return runFixedNumber(msg, cb, context);
        }
    }).then(() => {
        clearUpdateInter();
        return cb.end(transactionResults);
    }).then(() => {
        // conditionally trim beginning and end results for this test run
        if (msg.trim) {
            let trim;
            if (msg.txDuration) {
                // Considering time based number of transactions
                trim = Math.floor(msg.trim * (transactionResults.length / msg.txDuration));
            } else {
                // Considering set number of transactions
                trim = msg.trim;
            }
            let safeCut = (2 * trim) < transactionResults.length ? trim : transactionResults.length;
            transactionResults = transactionResults.slice(safeCut, transactionResults.length - safeCut);
        }
        console.log('Resolving doTest()');
        return Promise.resolve(transactionResults);
    }).catch((err) => {
        clearUpdateInter();
        log('Client ' + process.pid + ': error ' + (err.stack ? err.stack : err));
        return Promise.reject(err);
    });
}

/**
 * Message handler
 */
process.on('message', function (message) {
    if (message.hasOwnProperty('type')) {
        try {
            switch (message.type) {
            case 'test': {
                let result;
                doTest(message).then((output) => {
                    result = output;
                    return Util.sleep(200);
                }).then(() => {
                    console.log('Sending results to parent process.');
                    process.send({type: 'testResult', data: result});
                    return undefined;
                }).catch((e) => {
                    console.log("Error in doTest()", e);
                    process.send({type: 'error', data: e});
                });
                break;
            }
            default: {
                process.send({type: 'error', data: 'unknown message type'});
            }
            }
        }
        catch (err) {
            process.send({type: 'error', data: err});
        }
    }
    else {
        process.send({type: 'error', data: 'unknown message type'});
    }
});