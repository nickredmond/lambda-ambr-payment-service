"use strict"

const AWS = require("aws-sdk");
const jwt = require("jsonwebtoken");
var MongoClient = require("mongodb").MongoClient;

let atlas_connection_uri;
let cachedDb = null;

exports.handler = (event, context, callback) => {
    var connectionString = process.env["MONGODB_ATLAS_CLUSTER_URI"];

    if (atlas_connection_uri != null) {
        processEvent(event, context, callback);
    }
    else {
        decryptValueWithKMS(connectionString, 
            function(plainTextConnectionString) {
                atlas_connection_uri = plainTextConnectionString;
                processEvent(event, context, callback);
            },
            function(error) {
                sendResponseToApiGateway("ERROR decrypting database connection string.", 500, callback);
            }
        );
    }
};

function decryptValueWithKMS(encryptedValue, onSuccess, onError) {
    const kms = new AWS.KMS();
    kms.decrypt({ CiphertextBlob: new Buffer(encryptedValue, "base64") }, (err, data) => {
        if (err) {
            console.log("Decrypt error:", err);
            onError(err);
        } else {
            const plainTextConnectionString = data.Plaintext.toString("ascii");
            onSuccess(plainTextConnectionString);
        }
    });
}

function processEvent(event, context, callback) {
    console.log("calling Atlas from Lambda with event: " + JSON.stringify(event));
    var paymentRequest = JSON.parse(JSON.stringify(event));
    context.callbackWaitsForEmptyEventLoop = false;

    try {
        if (cachedDb == null) {
            console.log("=> connecting to database");
            MongoClient.connect(atlas_connection_uri, function(err, client) {
                cachedDb = client.db("ambr");
                return evaluatePaymentRequest(cachedDb, paymentRequest, callback);
            });
        }
        else {
            evaluatePaymentRequest(cachedDb, paymentRequest, callback);
        }
    }
    catch (err) {
        console.error("an error occurred", err);
    }
}

function evaluatePaymentRequest(db, paymentRequest, callback) {
    var userToken = paymentRequest.userToken;
    if (userToken) {
        var encryptedTokenKey = process.env["JWT_SECRET_KEY"];
        decryptValueWithKMS(encryptedTokenKey,
            function(plainTextTokenKey) {
                var decodedData = jwt.verify(userToken, plainTextTokenKey);
                if (decodedData && decodedData.id) {
                    findUserByEmail(db, decodedData.id,
                        function(user) {
                            processPayment(db, user, paymentRequest, callback);
                        },
                        function(error) {
                            if (error) {
                                sendResponseToApiGateway("ERROR retrieving user information during payment.", 500, callback);
                            } else {
                                sendResponseToApiGateway("No user found during payment.", 400, callback);
                            }
                        }
                    );
                }
            },
            function(error) {
                console.log("ERROR decrypting JWT key" + JSON.stringify(error));
            }
        );
    } else {
        sendResponseToApiGateway("No user token provided!", 401, callback);
    }
}

function processPayment(db, user, paymentRequest, callback) {
    var encryptedStripeKey = process.env["STRIPE_SECRET_KEY"];
    decryptValueWithKMS(encryptedStripeKey,
        function(stripeSecretKey) {
            const stripe = require("stripe")(stripeSecretKey);
            if (paymentRequest.isNewPaymentMethod) {
                saveNewPaymentMethod(db, user, paymentRequest.paymentMethod, callback);
            } else {
                submitPaymentToStripe(stripe, paymentRequest.paymentMethod.tokenId, paymentRequest.paymentAmount, callback);
            }
        },
        function(err) {
            console.log("ERROR decrypting Stripe key." + JSON.stringify(err));
        }
    );
}
function saveNewPaymentMethod(db, user, stripe, paymentMethod, callback) {
    const updatedPaymentMethods = user.paymentMethods || [];
    const customer = {
        source: paymentMethod.tokenId,
        email: user.email
    };
    stripe.customers.create(customer, function(err, customer) {
        if (err) {
            handleStripeApiError(err, callback);
        } else {
            // save customer.id as paymentMethod tokenId, as part of new paymentMethod in updated""Methods
            // submit payment to Stripe
        }
    });
}
function submitPaymentToStripe(stripe, customerId, paymentAmount, callback) {
    const charge = {
        amount: paymentAmount,
        currency: "usd",
        description: "Ambr auction bid/donation",
        customer: customerId
    };
    stripe.charges.create(charge, function(err, charge) {
        if (err) {
            handleStripeApiError(err, callback);
        } else {
            // record transaction
            // return success to front-end
        }
    });
}
function handleStripeApiError(err, callback) {
    // todo: handle this
}

function findUserByEmail(db, emailAddress, onSuccess, onError) {
    db.collection("users").findOne({ email: { $eq: emailAddress } }, function(err, user) {
        if (err) {
            onError(err);
        } else if (user) {
            onSuccess(user);
        } else {
            onError(null);
        }
    });
}

function sendClientErrorToApiGateway(errorMessage, callback) {
    sendResponseToApiGateway(errorMessage, 400, callback);
}
function sendDataToApiGateway(data, callback) {
    const messageBody = JSON.stringify(data);
    sendResponseToApiGateway(messageBody, 200, callback);
}
function sendResponseToApiGateway(messageBody, statusCode, callback) {
    const apiResponse = {
        "isBase64Encoded": false,
        "statusCode": statusCode,
        "headers": { "Content-Type": "application/json" },
        "body": messageBody
    };
    callback(null, apiResponse);
}