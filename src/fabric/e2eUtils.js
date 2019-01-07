/**
 * Modifications Copyright 2017 HUAWEI
 * Copyright 2017 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */


'use strict';

const commUtils = require('../comm/util');
const {TxErrorEnum, TxErrorIndex} = require('./constant.js');

const path = require('path');
const fs = require('fs');
const util = require('util');

const Client = require('fabric-client');
const testUtil = require('./util.js');

let ORGS;

let tx_id = null;
let the_user = null;

/**
 * Initialize the Fabric client configuration.
 * @param {string} config_path The path of the Fabric network configuration file.
 */
function init(config_path) {
    Client.addConfigFile(config_path);
    ORGS = Client.getConfigSetting('fabric').network;
}

module.exports.init = init;

/**
 * Deploy the given chaincode to the given organization's peers.
 * @param {string} org The name of the organization.
 * @param {object} chaincode The chaincode object from the configuration file.
 * @return {Promise} The return promise.
 */
function installChaincode(org, chaincode) {
    Client.setConfigSetting('request-timeout', 60000);
    const channel_name = chaincode.channel;

    const client = new Client();
    const channel = client.newChannel(channel_name);

    const orgName = ORGS[org].name;
    const cryptoSuite = Client.newCryptoSuite();
    cryptoSuite.setCryptoKeyStore(Client.newCryptoKeyStore({path: testUtil.storePathForOrg(orgName)}));
    client.setCryptoSuite(cryptoSuite);

    const caRootsPath = ORGS.orderer.tls_cacerts;
    let data = fs.readFileSync(caRootsPath);
    let caroots = Buffer.from(data).toString();

    channel.addOrderer(
        client.newOrderer(
            ORGS.orderer.url,
            {
                'pem': caroots,
                'ssl-target-name-override': ORGS.orderer['server-hostname']
            }
        )
    );

    const targets = [];
    for (let key in ORGS[org]) {
        if (ORGS[org].hasOwnProperty(key)) {
            if (key.indexOf('peer') === 0) {
                let data = fs.readFileSync(ORGS[org][key].tls_cacerts);
                let peer = client.newPeer(
                    ORGS[org][key].requests,
                    {
                        pem: Buffer.from(data).toString(),
                        'ssl-target-name-override': ORGS[org][key]['server-hostname']
                    }
                );

                targets.push(peer);
                channel.addPeer(peer);
            }
        }
    }

    return Client.newDefaultKeyValueStore({
        path: testUtil.storePathForOrg(orgName)
    }).then((store) => {
        client.setStateStore(store);

        // get the peer org's admin required to send install chaincode requests
        return testUtil.getSubmitter(client, true /* get peer org admin */, org);
    }).then((admin) => {
            the_user = admin;

            // send proposal to endorser
            const request = {
                targets: targets,
                chaincodePath: chaincode.path,
                chaincodeId: chaincode.id,
                chaincodeType: chaincode.language,
                chaincodeVersion: chaincode.version
            };
            return client.installChaincode(request);
        },
        (err) => {
            throw new Error('Failed to enroll user \'admin\'. ' + err);
        }).then((results) => {
            const proposalResponses = results[0];

            let all_good = true;
            const errors = [];
            for (let i in proposalResponses) {
                let one_good = false;
                if (proposalResponses && proposalResponses[i].response && proposalResponses[i].response.status === 200) {
                    one_good = true;
                } else {
                    errors.push(proposalResponses[i]);
                }
                all_good = all_good && one_good;
            }
            if (!all_good) {
                throw new Error(util.format('Failed to send install Proposal or receive valid response: %s', errors));
            }
            else {
                return true;
            }
        },
        (err) => {
            throw new Error('Failed to send install proposal due to error: ' + (err.stack ? err.stack : err));
        })
        .catch((err) => {
            return Promise.reject(err);
        });
}

module.exports.installChaincode = installChaincode;

/**
 * Disconnect from the given event hubs.
 * @param {object[]} ehs The collection of event hubs.
 */
function disconnect(ehs) {
    for (let key in ehs) {
        const eventhub = ehs[key];
        if (eventhub && eventhub.isconnected()) {
            eventhub.disconnect();
        }
    }
}

/**
 * Assemble a chaincode proposal request.
 * @param {Client} client The Fabric client object.
 * @param {User} the_user Unused.
 * @param {object} chaincode The chaincode object from the configuration file.
 * @param {boolean} upgrade Indicates whether the request is an upgrade or not.
 * @param {object} transientMap The transient map the request.
 * @param {object} endorsement_policy The endorsement policy object from the configuration file.
 * @return {object} The assembled chaincode proposal request.
 */
function buildChaincodeInstantiateUpgradeRequest(client, the_user, chaincode, upgrade, transientMap, endorsement_policy) {
    const tx_id = client.newTransactionID();

    // send proposal to endorser
    const request = {
        // chaincodePath: chaincode.path, //
        chaincodeId: chaincode.id,
        chaincodeType: chaincode.language,
        chaincodeVersion: chaincode.version,
        fcn: 'init',
        args: chaincode.init || [],
        txId: tx_id,
        'endorsement-policy': endorsement_policy
    };


    if (upgrade) {
        // use this call to test the transient map support during chaincode instantiation
        request.transientMap = transientMap;
    }

    return request;
}

/**
 * Instantiate or upgrade the given chaincode with the given endorsement policy.
 * @param {object} chaincode The chaincode object from the configuration file.
 * @param {object} endorsement_policy The endorsement policy object from the configuration file.
 * @param {boolean} upgrade Indicates whether the call is an upgrade or a new instantiation.
 * @return {Promise} The return promise.
 */
function instantiateChaincode(chaincode, endorsement_policy, upgrade) {
    Client.setConfigSetting('request-timeout', 120000);

    let channel = testUtil.getChannel(chaincode.channel);
    if (channel === null) {
        return Promise.reject(new Error('could not find channel in config'));
    }
    const channel_name = channel.name;
    const userOrg = channel.organizations[0];

    let eventhubs = [];
    let type = 'instantiate';
    if (upgrade) {
        type = 'upgrade';
    }
    const client = new Client();
    channel = client.newChannel(channel_name);

    const orgName = ORGS[userOrg].name;
    const cryptoSuite = Client.newCryptoSuite();
    cryptoSuite.setCryptoKeyStore(Client.newCryptoKeyStore({path: testUtil.storePathForOrg(orgName)}));
    client.setCryptoSuite(cryptoSuite);

    const caRootsPath = ORGS.orderer.tls_cacerts;
    let data = fs.readFileSync(caRootsPath);
    let caroots = Buffer.from(data).toString();

    channel.addOrderer(
        client.newOrderer(
            ORGS.orderer.url,
            {
                'pem': caroots,
                'ssl-target-name-override': ORGS.orderer['server-hostname']
            }
        )
    );

    const transientMap = {'test': 'transientValue'};

    return Client.newDefaultKeyValueStore({
        path: testUtil.storePathForOrg(orgName)
    }).then((store) => {
        console.info('Retreiving admin for organization:', userOrg);
        client.setStateStore(store);
        return testUtil.getSubmitter(client, true /* use peer org admin*/, userOrg);

    }).then((admin) => {
        the_user = admin;

        console.info('Adding peers to channel:', channel_name);
        let eventPeer = null;
        for (let org in ORGS) {
            if (org.indexOf('orderer') !== 0) {
                for (let key in ORGS[org]) {
                    if (key.indexOf('peer') === 0) {
                        let data = fs.readFileSync(ORGS[org][key].tls_cacerts);
                        let peer = client.newPeer(
                            ORGS[org][key].requests,
                            {
                                pem: Buffer.from(data).toString(),
                                'ssl-target-name-override': ORGS[org][key]['server-hostname']
                            });
                        channel.addPeer(peer);
                        if (org === userOrg && !eventPeer) {
                            eventPeer = key;
                        }
                    }
                }
            }
        }

        // an event listener can only register with a peer in its own org
        let data = fs.readFileSync(ORGS[userOrg][eventPeer].tls_cacerts);
        let eh = client.newEventHub();
        eh.setPeerAddr(
            ORGS[userOrg][eventPeer].events,
            {
                pem: Buffer.from(data).toString(),
                'ssl-target-name-override': ORGS[userOrg][eventPeer]['server-hostname']
            }
        );
        eh.connect();
        eventhubs.push(eh);

        // read the config block from the orderer for the channel
        // and initialize the verify MSPs based on the participating
        // organizations
        return channel.initialize();
    }, (err) => {
        throw new Error('Failed to enroll user \'admin\'. ' + err);

    }).then(() => {

        let request = buildChaincodeInstantiateUpgradeRequest(client, the_user, chaincode, upgrade, transientMap, endorsement_policy);
        tx_id = request.txId;
        return channel.sendInstantiateProposal(request);

    }, (err) => {
        throw new Error('Failed to initialize the channel' + (err.stack ? err.stack : err));
    }).then((results) => {

        const proposalResponses = results[0];

        const proposal = results[1];
        let all_good = true;
        for (let i in proposalResponses) {
            let one_good = false;
            if (proposalResponses[i].response && proposalResponses[i].response.status === 200) {
                one_good = true;
            }
            all_good = all_good && one_good;
        }
        if (all_good) {
            const request = {
                proposalResponses: proposalResponses,
                proposal: proposal,
            };

            // set the transaction listener and set a timeout of 5 mins
            // if the transaction did not get committed within the timeout period,
            // fail the test
            const deployId = tx_id.getTransactionID();

            const eventPromises = [];
            eventhubs.forEach((eh) => {
                let txPromise = new Promise((resolve, reject) => {
                    let handle = setTimeout(reject, 300000);

                    eh.registerTxEvent(deployId.toString(), (tx, code) => {
                        clearTimeout(handle);
                        eh.unregisterTxEvent(deployId);

                        if (code !== 'VALID') {
                            commUtils.log('The chaincode ' + type + ' transaction was invalid, code = ' + code);
                            reject();
                        } else {
                            commUtils.log('The chaincode ' + type + ' transaction was valid.');
                            resolve();
                        }
                    });
                });
                eventPromises.push(txPromise);
            });

            const sendPromise = channel.sendTransaction(request);
            return Promise.all([sendPromise].concat(eventPromises))
                .then((results) => {
                    return results[0]; // just first results are from orderer, the rest are from the peer events

                }).catch((err) => {
                    throw new Error('Failed to send ' + type + ' transaction and get notifications within the timeout period.');
                });

        } else {
            throw new Error('Failed to send ' + type + ' Proposal or receive valid response. Response null or status is not 200. exiting...');
        }
    }, (err) => {
        throw new Error('Failed to send ' + type + ' proposal due to error: ' + (err.stack ? err.stack : err));

    }).then((response) => {
        //TODO should look into the event responses
        if (response && !(response instanceof Error) && response.status === 'SUCCESS') {
            return Promise.resolve();
        } else {
            const error = 'Failed to order the ' + type + 'transaction. Error code: ' + (response) ? response.status : 'unknown';
            throw new Error(error);
        }
    }, (err) => {
        throw new Error('Failed to send instantiate due to error: ' + (err.stack ? err.stack : err));
    })
        .then(() => {
            disconnect(eventhubs);
            return Promise.resolve();
        })
        .catch((err) => {
            disconnect(eventhubs);
            return Promise.reject(err);
        });
}

module.exports.instantiateChaincode = instantiateChaincode;

/**
 * Get the peers of a given organization.
 * @param {string} orgName The name of the organization.
 * @return {string[]} The collection of peer names.
 */
function getOrgPeers(orgName) {
    const peers = [];
    const org = ORGS[orgName];
    for (let key in org) {
        if (org.hasOwnProperty(key)) {
            if (key.indexOf('peer') === 0) {
                peers.push(org[key]);
            }
        }
    }

    return peers;
}

const loadBalancingConfigurationGroups = [];
let groupsWithUrls = [];

/**
 * @param {*} channel - Channel
 * @param {Number} amountOfGroups - Amount of peer groups for load-balancing
 */
function createTransactionLoadBalancingGroups(channel, amountOfGroups) {
    if (amountOfGroups) {
        const allPeers = channel.getPeers();

        let remainder = allPeers.length % amountOfGroups;
        const groupSize = (allPeers.length - remainder) / amountOfGroups;
        const groupSizeToRemoveRemainder = groupSize + 1;

        for (let i = 0; i < amountOfGroups; i++) {
            if (remainder !== 0) {
                const group = allPeers.splice(0, groupSizeToRemoveRemainder);
                loadBalancingConfigurationGroups.push(group);
                remainder--;
            }
            else {
                const group = allPeers.splice(0, groupSize);
                loadBalancingConfigurationGroups.push(group);
            }
        }

        console.log('Created the following groups:');
        groupsWithUrls = loadBalancingConfigurationGroups.map(group => group.map(peer => peer.getUrl()));
        groupsWithUrls.forEach(group => console.log(group));
    }
}

let currentGroupIndex = 0;

/**
 * @param {*} request - Original request
 * @returns {*} - Adjusted request
 */
function createLoadBalancedTransactionProposalRequest(request) {
    if (loadBalancingConfigurationGroups.length > 1) {
        const targets = loadBalancingConfigurationGroups[currentGroupIndex];
        request.targets = targets;

        currentGroupIndex++;
        if (currentGroupIndex > loadBalancingConfigurationGroups.length - 1) {
            currentGroupIndex = 0;
        }
    }

    return request;
}

/**
 * Create a Fabric context based on the channel configuration.
 * @param {object} channelConfig The channel object from the configuration file.
 * @return {Promise<object>} The created Fabric context.
 */
function getcontext(channelConfig) {
    Client.setConfigSetting('request-timeout', 120000);
    const channel_name = channelConfig.name;
    // var userOrg = channelConfig.organizations[0];
    // choose a random org to use, for load balancing
    const idx = Math.floor(Math.random() * channelConfig.organizations.length);
    const userOrg = channelConfig.organizations[idx];

    const client = new Client();
    const channel = client.newChannel(channel_name);
    let orgName = ORGS[userOrg].name;
    const cryptoSuite = Client.newCryptoSuite();
    const eventhubs = [];
    cryptoSuite.setCryptoKeyStore(Client.newCryptoKeyStore({path: testUtil.storePathForOrg(orgName)}));
    client.setCryptoSuite(cryptoSuite);

    const caRootsPath = ORGS.orderer.tls_cacerts;
    let data = fs.readFileSync(caRootsPath);
    let caroots = Buffer.from(data).toString();

    channel.addOrderer(
        client.newOrderer(
            ORGS.orderer.url,
            {
                'pem': caroots,
                'ssl-target-name-override': ORGS.orderer['server-hostname']
            }
        )
    );

    orgName = ORGS[userOrg].name;
    return Client.newDefaultKeyValueStore({path: testUtil.storePathForOrg(orgName)})
        .then((store) => {
            if (store) {
                client.setStateStore(store);
            }
            return testUtil.getSubmitter(client, true, userOrg);
        }).then((admin) => {
            the_user = admin;

            // set up the channel to use each org's random peer for
            // both requests and events
            for (let i in channelConfig.organizations) {
                let org = channelConfig.organizations[i];
                let peers = getOrgPeers(org);

                if (peers.length === 0) {
                    throw new Error('could not find peer of ' + org);
                }
                else {
                    peers.forEach((peerInfo) => {
                        let data = fs.readFileSync(peerInfo.tls_cacerts);
                        let peer = client.newPeer(
                            peerInfo.requests,
                            {
                                pem: Buffer.from(data).toString(),
                                'ssl-target-name-override': peerInfo['server-hostname']
                            }
                        );
                        channel.addPeer(peer);

                        // an event listener can only register with the peer in its own org
                        if (org === userOrg) {
                            let eh = client.newEventHub();
                            eh.setPeerAddr(
                                peerInfo.events,
                                {
                                    pem: Buffer.from(data).toString(),
                                    'ssl-target-name-override': peerInfo['server-hostname'],
                                    //'request-timeout': 120000
                                    'grpc.keepalive_timeout_ms': 3000, // time to respond to the ping, 3 seconds
                                    'grpc.keepalive_time_ms': 360000   // time to wait for ping response, 6 minutes
                                    // 'grpc.http2.keepalive_time' : 15
                                }
                            );
                            eventhubs.push(eh);
                        }
                    });
                }
            }

            // register event listener
            eventhubs.forEach((eh) => {
                eh.connect();
            });

            return channel.initialize();
        })
        .then(() => {
            try {
                const amountofGroups = parseInt(process.env.LOAD_BALANCING_AMOUNT_OF_GROUPS);
                createTransactionLoadBalancingGroups(channel, amountofGroups);
            }
            catch (e) {
                console.log('Unable to create transaction load-balancing groups.', e);
            }

            return Promise.resolve({
                org: userOrg,
                client: client,
                channel: channel,
                submitter: the_user,
                eventhubs: eventhubs
            });
        })
        .catch((error) => {
            console.log('Failed to retreive blockchain context. Reason:', error.toString());
            console.log('Waiting:', 10, '(s) before retrying.');
            return commUtils.sleep(10000).then(() => {
                console.log('Retrying...');
                return getcontext(channelConfig);
            });
        });
}

module.exports.getcontext = getcontext;

/**
 * Disconnect the event hubs.
 * @param {object} context The Fabric context.
 * @return {Promise} The return promise.
 */
function releasecontext(context) {
    if (context.hasOwnProperty('eventhubs')) {
        for (let key in context.eventhubs) {
            const eventhub = context.eventhubs[key];
            if (eventhub && eventhub.isconnected()) {
                eventhub.disconnect();
            }
        }
        context.eventhubs = [];
    }
    return Promise.resolve();
}

module.exports.releasecontext = releasecontext;

async function createTransactionProposal(proposalResponseObject, channel, proposalRequest, timeout, invokeStatus) {
    try {
        proposalResponseObject = await channel.sendTransactionProposal(proposalRequest, timeout * 1000);
        invokeStatus.time_endorse = Date.now();
    } catch (err) {
        invokeStatus.time_endorse = Date.now();
        invokeStatus.error_flags |= TxErrorEnum.ProposalResponseError;
        invokeStatus.error_messages[TxErrorIndex.ProposalResponseError] = err.toString();
        // error occurred, early life-cycle termination, definitely failed
        invokeStatus.verified = true;
        proposalResponseObject = undefined;
        throw err; // handle logging in one place
    }
    return proposalResponseObject;
}

function inspectTransactionProposalResponses(proposalResponses, invokeStatus, allGood) {
    for (let i in proposalResponses) {
        let one_good = false;
        let proposal_response = proposalResponses[i];
        if (proposal_response && proposal_response.response && proposal_response.response.status === 200) {
            // TODO: the CPU cost of verifying response is too high.
            // Now we ignore this step to improve concurrent capacity for the client
            // so a client can initialize multiple concurrent transactions
            // Is it a reasonable way?
            // one_good = channel.verifyProposalResponse(proposal_response);
            one_good = true;
        } else {
            let err = new Error('Endorsement denied: ' + proposal_response.toString());
            invokeStatus.error_flags |= TxErrorEnum.BadProposalResponseError;
            invokeStatus.error_messages[TxErrorIndex.BadProposalResponseError] = err.toString();
            // explicit rejection, early life-cycle termination, definitely failedFq
            invokeStatus.verified = true;
            throw err;
        }
        allGood = allGood && one_good;
    }
    return allGood;
}

function compareEndorsements(allGood, channel, proposalResponses, invokeStatus) {
    if (allGood) {
        // check all the read/write sets to see if the same, verify that each peer
        // got the same results on the proposal
        allGood = channel.compareProposalResponseResults(proposalResponses);
        if (!allGood) {
            let err = new Error('Read/Write set mismatch between endorsements');
            invokeStatus.error_flags |= TxErrorEnum.BadProposalResponseError;
            invokeStatus.error_messages[TxErrorIndex.BadProposalResponseError] = err.toString();
            // r/w set mismatch, early life-cycle termination, definitely failed
            invokeStatus.verified = true;
            throw err;
        }
    }
}

function verifyTransactionsAreValid(eventHubs, timeout, txId, invokeStatus) {
    const transactionVerificationPromises = [];
    eventHubs.forEach((eh) => {
        transactionVerificationPromises.push(new Promise((resolve, reject) => {
            let handle = setTimeout(reject, timeout);

            eh.registerTxEvent(txId,
                (tx, code) => {
                    clearTimeout(handle);
                    eh.unregisterTxEvent(txId);

                    // either explicit invalid event or valid event, verified in both cases by at least one peer
                    invokeStatus.verified = true;
                    if (code !== 'VALID') {
                        let err = new Error('Invalid transaction: ' + code);
                        invokeStatus.error_flags |= TxErrorEnum.BadEventNotificationError;
                        invokeStatus.error_messages[TxErrorIndex.BadEventNotificationError] = err.toString();
                        reject(err); // handle error in final catch
                    } else {
                        resolve();
                    }
                },
                (err) => {
                    clearTimeout(handle);
                    // we don't know what happened, but give the other eventhub connections a chance
                    // to verify the Tx status, so resolve this call
                    invokeStatus.error_flags |= TxErrorEnum.EventNotificationError;
                    invokeStatus.error_messages[TxErrorIndex.EventNotificationError] = err.toString();
                    resolve();
                }
            );
        }));
    });
    return transactionVerificationPromises;
}

async function assembleEndorsementsAndSendTransactionToOrderer(channel, transactionRequest, invokeStatus, timeout) {
    let broadcastResponse;
    try {
        broadcastResponse = await channel.sendTransaction(transactionRequest, timeout);
    } catch (err) {
        // missing the ACK does not mean anything, the Tx could be already under ordering
        // so let the events decide the final status, but log this error
        invokeStatus.error_flags |= TxErrorEnum.OrdererResponseError;
        invokeStatus.error_messages[TxErrorIndex.OrdererResponseError] = err.toString();
    }

    invokeStatus.time_order = Date.now();

    if (broadcastResponse && broadcastResponse === 'SUCCESS') {
        invokeStatus.status = 'submitted';
    } else if (broadcastResponse && broadcastResponse.status !== 'SUCCESS') {
        let err = new Error('Received rejection from orderer service: ' + broadcastResponse.status);
        invokeStatus.error_flags |= TxErrorEnum.BadOrdererResponseError;
        invokeStatus.error_messages[TxErrorIndex.BadOrdererResponseError] = err.toString();
        // the submission was explicitly rejected, so the Tx will definitely not be ordered
        invokeStatus.verified = true;
        throw err;
    }
}

/**
 * Submit a transaction to the given chaincode with the specified options.
 * @param {object} context The Fabric context.
 * @param {string} id The name of the chaincode.
 * @param {string} version The version of the chaincode.
 * @param {string[]} args The arguments to pass to the chaincode.
 * @param {number} timeout The timeout for the transaction invocation.
 * @return {Promise<object>} The result and stats of the transaction invocation.
 */
async function invokebycontext(context, id, version, args, timeout) {
    const channel = context.channel;
    const eventHubs = context.eventhubs;
    const startTime = Date.now();
    const txIdObject = context.client.newTransactionID();
    const txId = txIdObject.getTransactionID().toString();

    // timestamps are recorded for every phase regardless of success/failure
    let invokeStatus = {
        id: txId,
        status: 'created',
        time_create: Date.now(),
        time_final: 0,
        time_endorse: 0,
        time_order: 0,
        result: null,
        verified: false, // if false, we cannot be sure that the final Tx status is accurate
        error_flags: TxErrorEnum.NoError, // the bitmask of error codes that happened during the Tx life-cycle
        error_messages: [] // the error messages corresponding to the error flags
    };

    // TODO: should resolve endorsement policy to decides the target of endorsers
    // now random peers ( one peer per organization ) are used as endorsers as default, see the implementation of getContext
    // send proposal to endorser
    const f = args[0];
    args.shift();
    const proposalRequest = createLoadBalancedTransactionProposalRequest({
        chaincodeId: id,
        fcn: f,
        args: args,
        txId: txIdObject,
    });

    let proposalResponseObject = null;
    try {
        if (context.engine) {
            context.engine.submitCallback(1);
        }
        proposalResponseObject = await createTransactionProposal(proposalResponseObject, channel, proposalRequest, timeout, invokeStatus);

        const proposalResponses = proposalResponseObject[0];
        const proposal = proposalResponseObject[1];

        const allGood = inspectTransactionProposalResponses(proposalResponses, invokeStatus, proposalResponseObject, true);
        compareEndorsements(allGood, channel, proposalResponses, invokeStatus);

        invokeStatus.result = proposalResponses[0].response.payload;

        const transactionRequest = {
            proposalResponses: proposalResponses,
            proposal: proposal,
        };

        let newTimeout = timeout * 1000 - (Date.now() - startTime);
        if (newTimeout < 10000) {
            commUtils.log('WARNING: timeout is too small, default value is used instead');
            newTimeout = 10000;
        }

        const eventPromises = verifyTransactionsAreValid(eventHubs, newTimeout, txId, invokeStatus);
        await assembleEndorsementsAndSendTransactionToOrderer(channel, transactionRequest, invokeStatus, timeout * 1000);

        const promise = Promise.all(eventPromises);
        promise.catch((err) => {
            throw err;
        });
        await promise;

        // if the Tx is not verified at this point, then every eventhub connection failed (with resolve)
        // so mark it failed but leave it not verified
        if (!invokeStatus.verified) {
            invokeStatus.status = 'failed';
            // commUtils.log('Failed to complete transaction [' + txId.substring(0, 5) + '...]: every eventhub connection closed');
        } else {
            invokeStatus.status = 'success';
            invokeStatus.verified = true;
        }
    } catch (err) {
        // at this point the Tx should be verified
        invokeStatus.status = 'failed';
        // console.log('Failed to complete transaction [' + txId.substring(0, 5) + '...]:' + ((err && err instanceof Error) ? err.stack : err), JSON.stringify(invokeStatus.error_messages));
    }

    invokeStatus.time_final = Date.now();
    return invokeStatus;
}

module.exports.invokebycontext = invokebycontext;

/**
 * Submit a query to the given chaincode with the specified options.
 * @param {object} context The Fabric context.
 * @param {string} id The name of the chaincode.
 * @param {string} version The version of the chaincode.
 * @param {string} name The single argument to pass to the chaincode.
 * @return {Promise<object>} The result and stats of the transaction invocation.
 */
function querybycontext(context, id, version, name) {
    //const userOrg = context.org;
    const client = context.client;
    const channel = context.channel;
    //const eventhubs = context.eventhubs;
    const tx_id = client.newTransactionID();
    const invoke_status = {
        id: tx_id.getTransactionID(),
        status: 'created',
        time_create: Date.now(),
        time_final: 0,
        result: null
    };

    // send query
    const request = {
        chaincodeId: id,
        chaincodeVersion: version,
        txId: tx_id,
        fcn: 'query',
        args: [name]
    };

    if (context.engine) {
        context.engine.submitCallback(1);
    }

    return channel.queryByChaincode(request)
        .then((responses) => {
            if (responses.length > 0) {
                const value = responses[0];
                if (value instanceof Error) {
                    throw value;
                }

                for (let i = 1; i < responses.length; i++) {
                    if (responses[i].length !== value.length || !responses[i].every(function (v, idx) {
                        return v === value[idx];
                    })) {
                        throw new Error('conflicting query responses');
                    }
                }

                invoke_status.time_final = Date.now();
                invoke_status.result = responses[0];
                invoke_status.status = 'success';
                return Promise.resolve(invoke_status);
            }
            else {
                throw new Error('no query responses');
            }
        })
        .catch((err) => {
            commUtils.log('Query failed, ' + (err.stack ? err.stack : err));
            invoke_status.time_final = Date.now();
            invoke_status.status = 'failed';
            return Promise.resolve(invoke_status);
        });
}

module.exports.querybycontext = querybycontext;

/**
 * Read all file contents in the given directory.
 * @param {string} dir The path of the directory.
 * @return {object[]} The collection of raw file contents.
 */
function readAllFiles(dir) {
    const files = fs.readdirSync(dir);
    const certs = [];
    files.forEach((file_name) => {
        let file_path = path.join(dir, file_name);
        let data = fs.readFileSync(file_path);
        certs.push(data);
    });
    return certs;
}

module.exports.readAllFiles = readAllFiles;
