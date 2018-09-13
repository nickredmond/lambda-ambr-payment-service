"use strict"

const AWS = require("aws-sdk");
const jwt = require("jsonwebtoken");

var mongodb = require("mongodb");
const ObjectId = mongodb.ObjectID;
const MongoClient = mongodb.MongoClient;

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
                saveNewPaymentMethod(db, user, stripe, paymentRequest, callback);
            } else {
                saveIntendedPayment(db, user, paymentRequest.paymentMethod.tokenId, paymentRequest.bidType, paymentRequest.auctionId, paymentRequest.paymentAmount, callback);
            }
        },
        function(err) {
            console.log("ERROR decrypting Stripe key." + JSON.stringify(err));
        }
    );
}
function saveNewPaymentMethod(db, user, stripe, paymentRequest, callback) {
    const updatedPaymentMethods = user.paymentMethods || [];
    const customer = {
        source: paymentRequest.paymentMethod.tokenId,
        email: user.email
    };
    stripe.customers.create(customer, function(err, customer) {
        if (err) {
            handleStripeApiError(err, callback);
        } else {
            const newPaymentMethod = {
                tokenId: customer.id,
                lastFourDigits: paymentRequest.paymentMethod.lastFourDigits,
                cardBrand: paymentRequest.paymentMethod.cardBrand
            };
            updatedPaymentMethods.push(newPaymentMethod);

            db.collection("users").updateOne(
                { email: user.email },
                { $set: { paymentMethods: updatedPaymentMethods } },
                function(err, result) {
                    if (err) {
                        const messageBody = {
                            isErrorSavingNewCard: true
                        };
                        sendResponseToApiGateway(messageBody, 500, callback);
                    } else {
                        saveIntendedPayment(db, user, customer.id, paymentRequest.bidType, paymentRequest.auctionId, paymentRequest.paymentAmount, callback);
                    }
                }
            );
        }
    });
}

// goto "Payment info stored! See results."
// then, isHighestBid and highestBidAmount are returned
// should everyone's money be refuneded if not enough $$$ is raised? (will be refunded if auction is canceled)
// for added/donated items, there is NO minimum fundraising requirement, i.e. highest bidder gets it (perhaps set max requirement, or "limit"?)
function saveIntendedPayment(db, user, stripeCustomerId, bidType, auctionId, amount, callback) {
    // get highest bid and compare
    // add bid permission based on donateType: 
    //  - if bid then add user bidPermission[bidId=nowHighestBid.id, auctionId]
    //  - if donate then add user bidPermission[bidId=null, auctionId]
    const payment = {
        userId: user._id,
        stripeCustomerId,
        bidType,
        auctionId,
        amount,
        status: "pending"
    };
    db.collection("payments").insertOne(payment, function(err, result) {
        if (err) {
            console.log("ERROR saving payment submission for user " + user._id.toString(), err);
            sendResponseToApiGateway("ERROR saving payment submission.", 500, callback);
        } else {
            evaluateHighestBid(db, user, auctionId, amount, bidType, callback);
        }
    });
}
function evaluateHighestBid(db, user, auctionId, amount, bidType, callback) {
    db.collection("auctions").findOne({ _id: ObjectId(auctionId) }, function(err, auction) {
        if (err) {
            console.log("ERROR finding auction by ID " + auctionId, err);
            sendResponseToApiGateway("ERROR finding auction by id " + auctionId, 500, callback);
        } else {
            const isHighestBid = auction.highestBid ? auction.highestBid.amount < amount : true;
            let highestBid = auction.highestBid;
            if (isHighestBid) {
                highestBid = {
                    userId: user._id,
                    amount: amount
                };
                db.collection("auctions").updateOne(
                    { _id: { $eq: auctionId } },
                    { $set: { highestBid: highestBid } },
                    function(err, result) {
                        if (err) {
                            console.log("ERROR setting highest bid for user " + user._id.toString(), err);
                            sendResponseToApiGateway("ERROR setting highest bid [userId:" + user._id + ", amount:" + amount + "]", 500, callback);
                        } else {
                            updateBidViewingPermission(db, user, auctionId, bidType, amount, true, callback);
                        }
                    }
                );
            } else {
                updateBidViewingPermission(db, user, auctionId, bidType, highestBid.amount, false, callback);
            }
        }
    });
}
function updateBidViewingPermission(db, user, auctionId, bidType, highestBidAmount, isHighestBid, callback) {
    let permission = null;
    const MINUTES_TIL_EXPIRY = 5;

    if (bidType === "bid") {
        const MILLIS_PER_MINUTE = 60000;
        const MILLIS_TIL_EXPIRY = MINUTES_TIL_EXPIRY * MILLIS_PER_MINUTE;
        const expiryDate = new Date(new Date().getTime() + MILLIS_TIL_EXPIRY);

        permission = { auctionId, expiry: expiryDate };
    } else if (bidType === "donation") {
        permission = { auctionId, expiry: null };
    }

    if (permission) {
        const updatedPermissions = user.bidViewPermissions ? user.bidViewPermissions.filter(permission => {
            return permission.auctionId !== auctionId;
        }) : [];
        updatedPermissions.push(permission);

        db.collection("users").updateOne(
            { _id: { $eq: user._id } },
            { $set: { bidViewPermissions: updatedPermissions } },
            function(err, result) {
                if (err) {
                    console.log("ERROR updating user[" + user._id + "] bid view permissions." + JSON.stringify(err));
                    sendResponseToApiGateway("ERROR updating user's permissions to view bids.", 500, callback);
                } else {
                    if (!result) {
                        console.log("ERROR finding user[" + user._id + "] to give bid permissions.");
                    }
                    
                    var responseBody = {
                        highestBidAmount,
                        isHighestBid,
                        isPermissionExpires: bidType !== "donation"
                    };
                    sendResponseToApiGateway(responseBody, 200, callback);
                } 
            }
        );
    }
}

// function submitPaymentToStripe(stripe, customerId, paymentAmount, callback) {
//     const charge = {
//         amount: paymentAmount,
//         currency: "usd",
//         description: "Ambr auction bid/donation",
//         customer: customerId
//     };
//     stripe.charges.create(charge, function(err, charge) {
//         if (err) {
//             handleStripeApiError(err, callback);
//         } else {
//             // record transaction/charge (see Stripe API for what's recorded)
//             // return success to front-end
//         }
//     });
// }

function handleStripeApiError(err, callback) {
    console.log("ERROR returned from Stripe API: " + JSON.stringify(err));

    if (err.type === "StripeCardError") {
        var messageBody = {
            isCardDeclined: true
        };
        sendResponseToApiGateway(messageBody, 400, callback);
    } else if (err.type === "RateLimitError") {
        var messageBody = {
            isRateLimitTooHigh: true
        };
        sendResponseToApiGateway(messageBody, 500, callback);
    } else {
        var messageBody = {
            isUnknownError: true
        };
        sendResponseToApiGateway(messageBody, 500, callback);
    }
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