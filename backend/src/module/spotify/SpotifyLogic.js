const UserLogic = require('../user/UserLogic');
const AccessTokenLogic = require('./access-token/AccessTokenLogic');
const SpotifyStore = require('../spotify/SpotifyStore');
const JsonHelper = require('../../core/helper/JsonHelper');
const querystring = require('querystring');
const https = require("https");

const AUTHORIZATION = {
    SCOPES: 'user-read-private user-read-email user-top-read',
    // @todo build redirect page
    REDIRECT_URI: 'http://localhost:8080/api/spotify/redirect',
}

// @todo remove hard coded client id and secret, transfer to env variable.
const CLIENT = {
    ID: '993e260818e14852b08b78fc9e7055eb',
    SECRET: '',
}

const OPTIONS = {
    host: 'accounts.spotify.com',
    path: '/api/token',
    method: 'POST',
    headers: {
        'Authorization': 'Basic ' + new Buffer(`${CLIENT.ID}:${CLIENT.SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
    }
};

class SpotifyLogic {

    /**
     * @returns spotify's interface for the user to authenticate.
     */ 
    static getAuthorizationURI() {
        const {SCOPES, REDIRECT_URI} = AUTHORIZATION;
        const stateValue = SpotifyStore.getStateValue();

        return 'https://accounts.spotify.com/authorize' +
        '?response_type=code' +
        '&client_id=' + CLIENT.ID +
        (SCOPES ? '&scope=' + encodeURIComponent(SCOPES) : '') +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&state=' + stateValue;
    }

    /**
     * Method to handle the redirect executed by the accounts.spotify's authorize endpoint.
     * @param object obj containing the authorization code and state previously sent to the endpoint.
     * @param function the method to emit the response.
     */
    static handleRedirect({code, state}, responseEmitter) {
        if (!SpotifyStore.removeStateValue(state)) {
            return responseEmitter({status: 500, message: 'No corresponding state found on SpotifyStore.'});
        }

        this.requestAccessToken(code, responseEmitter);
    }

    /**
     * Method to request an accessToken to the accounts.spotify's api/token endpoint.
     * @param string the authorization code.
     * @param function the method to emit the response.
     */ 
    static requestAccessToken(code, responseEmitter, userId) {
        const {REDIRECT_URI} = AUTHORIZATION;

        const postData = querystring.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
        });

        const now = Date.now();
        const req = https.request(OPTIONS, res => {
            res.on('data', this._handleAccessTokenResponse.bind(this, responseEmitter, now, userId));
        });
          
        req.on('error', err => {
            responseEmitter({status: 500, message: err.message});
        });

        req.end(postData);
    }

    /**
     * Creates/updates an accessToken and creates a new user if it doesn't exist yet.
     * @param function the method to emit the response (in success, emits a new jsonWebToken).
     * @param long the date (in ms) right before the request.
     * @param object the response data containing the accessToken.
     */ 
    static _handleAccessTokenResponse(responseEmitter, now, userId, data) {
        const accessTokenObj = JsonHelper.parse(data);

        this.getSpotifyUserInfo(accessTokenObj.access_token, async ({status, spotifyUser, message}) => {
            if (status !== 200) return responseEmitter({status, message});

            try {
                let jsonWebToken;
                if (!userId) {
                    userId = await UserLogic.getBySpotifyId(spotifyUser.id);
                }

                if (!userId) {
                    const {jwtToken, user: {_id: createdId}} = await UserLogic.createUserFromSpotifyUser(spotifyUser);
                    jsonWebToken = jwtToken;

                    await AccessTokenLogic.post(accessTokenObj, createdId, now);
                } else {
                    jsonWebToken = UserLogic.generateJWT(userId);

                    await AccessTokenLogic.putByUserId(accessTokenObj, userId, now);
                }

                responseEmitter({status, jsonWebToken, accessToken: accessTokenObj.access_token});
            } catch (err) {
                responseEmitter(err.status ? err : {status: 500, message: err.message});
            }
        });
    }

    /**
     * Gets the spotify user's info.
     * @param string the spotify's generated access token for some user.
     * @param function a function to be called back with the user's info.
     */
    static getSpotifyUserInfo(accessToken, callback) {
        const options = {
            host: 'api.spotify.com',
            path: '/v1/me',
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + accessToken,
            }
        };

        const req = https.request(options, res => {
            res.on('data', data => callback({status: 200, spotifyUser: JsonHelper.parse(data)}));
        });
          
        req.on('error', err => {
            callback({status: 500, message: err.message});
        });

        req.end();
    }

    /**
     * Gets the spotify's top artists/tracks for an user.
     * @param type the returning object type (artist/track)
     * @param function a function to be called back with the user's info.
     */
    static getTop(accessToken, type, callback) {
        
        const options = {
            host: 'api.spotify.com',
            path: `/v1/me/top/${type}?limit=25`,
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + accessToken,
            }
        };

        const req = https.request(options, res => {
            let fullData = '';
            res.on('data', data => {
                fullData += data;
            });
            res.on('end', () => {
                callback({status: 200, data: JSON.parse(fullData)});
            });
        });

        req.on('error', err => callback({status: 500, message: err.message}));

        req.end();
    }

    /**
     * This method is called if the user does not accepted the request.
     * @param object an object containing the error and passed state.
     * @param function the method to emit the response. 
     */
    static handleAccessDenied({error, state}, responseEmitter) {
        SpotifyStore.removeStateValue(state);
        responseEmitter({status: 401, message: error});
    } 
}

module.exports = SpotifyLogic;