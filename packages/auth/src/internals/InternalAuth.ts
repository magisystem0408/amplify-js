// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
	AuthOptions,
	FederatedResponse,
	SignUpParams,
	FederatedUser,
	ConfirmSignUpOptions,
	SignOutOpts,
	CurrentUserOpts,
	GetPreferredMFAOpts,
	SignInOpts,
	isUsernamePasswordOpts,
	isCognitoHostedOpts,
	isFederatedSignInOptions,
	isFederatedSignInOptionsCustom,
	hasCustomState,
	FederatedSignInOptionsCustom,
	LegacyProvider,
	FederatedSignInOptions,
	AwsCognitoOAuthOpts,
	ClientMetaData,
} from '../types';

import {
	Amplify,
	AuthAction,
	ConsoleLogger as Logger,
	Credentials,
	CustomUserAgentDetails,
	getAmplifyUserAgent,
	Hub,
	StorageHelper,
	ICredentials,
	Platform,
	browserOrNode,
	parseAWSExports,
	UniversalStorage,
	urlSafeDecode,
	HubCallback,
} from '@aws-amplify/core';
import {
	CookieStorage,
	AuthenticationDetails,
	ICognitoUserPoolData,
	ICognitoUserData,
	ISignUpResult,
	CognitoUser,
	MFAOption,
	CognitoUserSession,
	IAuthenticationCallback,
	ICognitoUserAttributeData,
	CognitoUserAttribute,
	CognitoIdToken,
	CognitoRefreshToken,
	CognitoAccessToken,
	NodeCallback,
	CodeDeliveryDetails,
} from 'amazon-cognito-identity-js';
import {
	addAuthCategoryToCognitoUserAgent,
	addFrameworkToCognitoUserAgent,
	InternalCognitoUser,
	InternalCognitoUserPool,
} from 'amazon-cognito-identity-js/internals';

import { parse } from 'url';
import OAuth from '../OAuth/OAuth';
import { default as urlListener } from '../urlListener';
import { AuthError, NoUserPoolError } from '../Errors';
import {
	AuthErrorTypes,
	AutoSignInOptions,
	CognitoHostedUIIdentityProvider,
	IAuthDevice,
} from '../types/Auth';
import { getAuthUserAgentDetails, getAuthUserAgentValue } from '../utils';

const logger = new Logger('AuthClass');
const USER_ADMIN_SCOPE = 'aws.cognito.signin.user.admin';

// 10 sec, following this guide https://www.nngroup.com/articles/response-times-3-important-limits/
const OAUTH_FLOW_MS_TIMEOUT = 10 * 1000;

const AMPLIFY_SYMBOL = (
	typeof Symbol !== 'undefined' && typeof Symbol.for === 'function'
		? Symbol.for('amplify_default')
		: '@@amplify_default'
) as Symbol;

const dispatchAuthEvent = (event: string, data: any, message: string) => {
	Hub.dispatch('auth', { event, data, message }, 'Auth', AMPLIFY_SYMBOL);
};

// Cognito Documentation for max device
// tslint:disable-next-line:max-line-length
// https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_ListDevices.html#API_ListDevices_RequestSyntax
const MAX_DEVICES = 60;

const MAX_AUTOSIGNIN_POLLING_MS = 3 * 60 * 1000;

/**
 * Provide authentication steps
 */
export class InternalAuthClass {
	private _config: AuthOptions;
	private userPool: InternalCognitoUserPool = null;
	private user: any = null;
	private _oAuthHandler: OAuth;
	private _storage;
	private _storageSync;
	private oAuthFlowInProgress: boolean = false;
	private pendingSignIn: ReturnType<
		InternalAuthClass['signInWithPassword']
	> | null;
	private autoSignInInitiated: boolean = false;
	private inflightSessionPromise: Promise<CognitoUserSession> | null = null;
	private inflightSessionPromiseCounter: number = 0;
	Credentials = Credentials;

	/**
	 * Initialize Auth with AWS configurations
	 * @param {Object} config - Configuration of the Auth
	 */
	constructor(config: AuthOptions) {
		this.configure(config);
		this.currentCredentials = this.currentCredentials.bind(this);
		this.currentUserCredentials = this.currentUserCredentials.bind(this);

		Hub.listen('auth', ({ payload }) => {
			const { event } = payload;
			switch (event) {
				case 'verify':
				case 'signIn':
					this._storage.setItem('amplify-signin-with-hostedUI', 'false');
					break;
				case 'signOut':
					this._storage.removeItem('amplify-signin-with-hostedUI');
					break;
				case 'cognitoHostedUI':
					this._storage.setItem('amplify-signin-with-hostedUI', 'true');
					break;
			}
		});

		addAuthCategoryToCognitoUserAgent();
		addFrameworkToCognitoUserAgent(Platform.framework);
		Platform.observeFrameworkChanges(() => {
			addFrameworkToCognitoUserAgent(Platform.framework);
		});
	}

	public getModuleName() {
		return 'InternalAuth';
	}

	configure(config?) {
		if (!config) return this._config || {};
		logger.debug('configure Auth');
		const conf = Object.assign(
			{},
			this._config,
			parseAWSExports(config).Auth,
			config
		);
		this._config = conf;
		const {
			userPoolId,
			userPoolWebClientId,
			cookieStorage,
			oauth,
			region,
			identityPoolId,
			mandatorySignIn,
			refreshHandlers,
			identityPoolRegion,
			clientMetadata,
			endpoint,
			storage,
		} = this._config;

		if (!storage) {
			// backward compatability
			if (cookieStorage) this._storage = new CookieStorage(cookieStorage);
			else {
				this._storage = config.ssr
					? new UniversalStorage()
					: new StorageHelper().getStorage();
			}
		} else {
			if (!this._isValidAuthStorage(storage)) {
				logger.error('The storage in the Auth config is not valid!');
				throw new Error('Empty storage object');
			}
			this._storage = storage;
		}

		this._storageSync = Promise.resolve();
		if (typeof this._storage['sync'] === 'function') {
			this._storageSync = this._storage['sync']();
		}

		if (userPoolId) {
			const userPoolData: ICognitoUserPoolData = {
				UserPoolId: userPoolId,
				ClientId: userPoolWebClientId,
				endpoint,
			};
			userPoolData.Storage = this._storage;

			this.userPool = new InternalCognitoUserPool(
				userPoolData,
				this.wrapRefreshSessionCallback
			);
		}

		this.Credentials.configure({
			mandatorySignIn,
			region,
			userPoolId,
			identityPoolId,
			refreshHandlers,
			storage: this._storage,
			identityPoolRegion,
		});

		// initialize cognitoauth client if hosted ui options provided
		// to keep backward compatibility:
		const cognitoHostedUIConfig = oauth
			? isCognitoHostedOpts(this._config.oauth)
				? oauth
				: (<any>oauth).awsCognito
			: undefined;

		if (cognitoHostedUIConfig) {
			const cognitoAuthParams = Object.assign(
				{
					cognitoClientId: userPoolWebClientId,
					UserPoolId: userPoolId,
					domain: cognitoHostedUIConfig['domain'],
					scopes: cognitoHostedUIConfig['scope'],
					redirectSignIn: cognitoHostedUIConfig['redirectSignIn'],
					redirectSignOut: cognitoHostedUIConfig['redirectSignOut'],
					responseType: cognitoHostedUIConfig['responseType'],
					Storage: this._storage,
					urlOpener: cognitoHostedUIConfig['urlOpener'],
					clientMetadata,
				},
				cognitoHostedUIConfig['options']
			);

			this._oAuthHandler = new OAuth({
				scopes: cognitoAuthParams.scopes,
				config: cognitoAuthParams,
				cognitoClientId: cognitoAuthParams.cognitoClientId,
			});

			// **NOTE** - Remove this in a future major release as it is a breaking change
			// Prevents _handleAuthResponse from being called multiple times in Expo
			// See https://github.com/aws-amplify/amplify-js/issues/4388
			const usedResponseUrls = {};
			// Only register urlListener once
			if (this.getModuleName() === 'InternalAuth') {
				urlListener(({ url }) => {
					if (usedResponseUrls[url]) {
						return;
					}

					usedResponseUrls[url] = true;
					this._handleAuthResponse(url);
				});
			}
		}

		dispatchAuthEvent(
			'configured',
			null,
			`The Auth category has been configured successfully`
		);

		if (
			!this.autoSignInInitiated &&
			typeof this._storage['getItem'] === 'function'
		) {
			const pollingInitiated = this.isTrueStorageValue(
				'amplify-polling-started'
			);
			if (pollingInitiated) {
				dispatchAuthEvent(
					'autoSignIn_failure',
					null,
					AuthErrorTypes.AutoSignInError
				);
				this._storage.removeItem('amplify-auto-sign-in');
			}
			this._storage.removeItem('amplify-polling-started');
		}
		return this._config;
	}

	wrapRefreshSessionCallback = (callback: NodeCallback.Any) => {
		const wrapped: NodeCallback.Any = (error, data) => {
			if (data) {
				dispatchAuthEvent('tokenRefresh', undefined, `New token retrieved`);
			} else {
				dispatchAuthEvent(
					'tokenRefresh_failure',
					error,
					`Failed to retrieve new token`
				);
			}
			return callback(error, data);
		};
		return wrapped;
	} // prettier-ignore

	/**
	 * Sign up with username, password and other attributes like phone, email
	 * @param {String | object} params - The user attributes used for signin
	 * @param {String[]} restOfAttrs - for the backward compatability
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves callback data if success
	 */
	public signUp(
		params: string | SignUpParams,
		...restOfAttrs: any
	): Promise<ISignUpResult>;
	public signUp(
		params: string | SignUpParams,
		restOfAttrs?: string[],
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<ISignUpResult> {
		if (!this.userPool) {
			return this.rejectNoUserPool();
		}

		let username: string = null;
		let password: string = null;
		const attributes: CognitoUserAttribute[] = [];
		let validationData: CognitoUserAttribute[] = null;
		let clientMetadata;
		let autoSignIn: AutoSignInOptions = { enabled: false };
		let autoSignInValidationData = {};
		let autoSignInClientMetaData: ClientMetaData = {};

		if (params && typeof params === 'string') {
			username = params;
			password = restOfAttrs ? restOfAttrs[0] : null;
			const email: string = restOfAttrs ? restOfAttrs[1] : null;
			const phone_number: string = restOfAttrs ? restOfAttrs[2] : null;

			if (email)
				attributes.push(
					new CognitoUserAttribute({ Name: 'email', Value: email })
				);

			if (phone_number)
				attributes.push(
					new CognitoUserAttribute({
						Name: 'phone_number',
						Value: phone_number,
					})
				);
		} else if (params && typeof params === 'object') {
			username = params['username'];
			password = params['password'];

			if (params && params.clientMetadata) {
				clientMetadata = params.clientMetadata;
			} else if (this._config.clientMetadata) {
				clientMetadata = this._config.clientMetadata;
			}

			const attrs = params['attributes'];
			if (attrs) {
				Object.keys(attrs).map(key => {
					attributes.push(
						new CognitoUserAttribute({ Name: key, Value: attrs[key] })
					);
				});
			}

			const validationDataObject = params['validationData'];
			if (validationDataObject) {
				validationData = [];
				Object.keys(validationDataObject).map(key => {
					validationData.push(
						new CognitoUserAttribute({
							Name: key,
							Value: validationDataObject[key],
						})
					);
				});
			}

			autoSignIn = params.autoSignIn ?? { enabled: false };
			if (autoSignIn.enabled) {
				this._storage.setItem('amplify-auto-sign-in', 'true');
				autoSignInValidationData = autoSignIn.validationData ?? {};
				autoSignInClientMetaData = autoSignIn.clientMetaData ?? {};
			}
		} else {
			return this.rejectAuthError(AuthErrorTypes.SignUpError);
		}

		if (!username) {
			return this.rejectAuthError(AuthErrorTypes.EmptyUsername);
		}
		if (!password) {
			return this.rejectAuthError(AuthErrorTypes.EmptyPassword);
		}

		logger.debug('signUp attrs:', attributes);
		logger.debug('signUp validation data:', validationData);

		return new Promise((resolve, reject) => {
			const userAgentDetails = getAuthUserAgentDetails(
				AuthAction.SignUp,
				customUserAgentDetails
			);
			this.userPool.signUp(
				username,
				password,
				attributes,
				validationData,
				(err, data) => {
					if (err) {
						dispatchAuthEvent(
							'signUp_failure',
							err,
							`${username} failed to signup`
						);
						reject(err);
					} else {
						dispatchAuthEvent(
							'signUp',
							data,
							`${username} has signed up successfully`
						);
						if (autoSignIn.enabled) {
							this.handleAutoSignIn(
								username,
								password,
								autoSignInValidationData,
								autoSignInClientMetaData,
								data,
								userAgentDetails
							);
						}
						resolve(data);
					}
				},
				clientMetadata,
				getAmplifyUserAgent(userAgentDetails)
			);
		});
	}

	private handleAutoSignIn(
		username: string,
		password: string,
		validationData: {},
		clientMetadata: any,
		data: any,
		customUserAgentDetails: CustomUserAgentDetails
	) {
		this.autoSignInInitiated = true;
		const authDetails = new AuthenticationDetails({
			Username: username,
			Password: password,
			ValidationData: validationData,
			ClientMetadata: clientMetadata,
		});
		if (data.userConfirmed) {
			this.signInAfterUserConfirmed(authDetails, customUserAgentDetails);
		} else if (this._config.signUpVerificationMethod === 'link') {
			this.handleLinkAutoSignIn(authDetails, customUserAgentDetails);
		} else {
			this.handleCodeAutoSignIn(authDetails, customUserAgentDetails);
		}
	}

	private handleCodeAutoSignIn(
		authDetails: AuthenticationDetails,
		customUserAgentDetails: CustomUserAgentDetails
	) {
		const listenEvent = ({ payload }) => {
			if (payload.event === 'confirmSignUp') {
				this.signInAfterUserConfirmed(
					authDetails,
					customUserAgentDetails,
					listenEvent
				);
			}
		};
		Hub.listen('auth', listenEvent);
	}

	private handleLinkAutoSignIn(
		authDetails: AuthenticationDetails,
		customUserAgentDetails: CustomUserAgentDetails
	) {
		this._storage.setItem('amplify-polling-started', 'true');
		const start = Date.now();
		const autoSignInPollingIntervalId = setInterval(() => {
			if (Date.now() - start > MAX_AUTOSIGNIN_POLLING_MS) {
				clearInterval(autoSignInPollingIntervalId);
				dispatchAuthEvent(
					'autoSignIn_failure',
					null,
					'Please confirm your account and use your credentials to sign in.'
				);
				this._storage.removeItem('amplify-auto-sign-in');
			} else {
				this.signInAfterUserConfirmed(
					authDetails,
					customUserAgentDetails,
					undefined,
					autoSignInPollingIntervalId
				);
			}
		}, 5000);
	}

	private async signInAfterUserConfirmed(
		authDetails: AuthenticationDetails,
		customUserAgentDetails: CustomUserAgentDetails,
		listenEvent?: HubCallback,
		autoSignInPollingIntervalId?: ReturnType<typeof setInterval>
	) {
		const user = this.createCognitoUser(authDetails.getUsername());
		try {
			await user.authenticateUser(
				authDetails,
				this.authCallbacks(
					user,
					value => {
						dispatchAuthEvent(
							'autoSignIn',
							value,
							`${authDetails.getUsername()} has signed in successfully`
						);
						if (listenEvent) {
							Hub.remove('auth', listenEvent);
						}
						if (autoSignInPollingIntervalId) {
							clearInterval(autoSignInPollingIntervalId);
							this._storage.removeItem('amplify-polling-started');
						}
						this._storage.removeItem('amplify-auto-sign-in');
					},
					error => {
						logger.error(error);
						this._storage.removeItem('amplify-auto-sign-in');
					},
					customUserAgentDetails
				),
				getAmplifyUserAgent(customUserAgentDetails)
			);
		} catch (error) {
			logger.error(error);
		}
	}

	/**
	 * Send the verification code to confirm sign up
	 * @param {String} username - The username to be confirmed
	 * @param {String} code - The verification code
	 * @param {ConfirmSignUpOptions} options - other options for confirm signup
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves callback data if success
	 */
	public confirmSignUp(
		username: string,
		code: string,
		options?: ConfirmSignUpOptions,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<any> {
		if (!this.userPool) {
			return this.rejectNoUserPool();
		}
		if (!username) {
			return this.rejectAuthError(AuthErrorTypes.EmptyUsername);
		}
		if (!code) {
			return this.rejectAuthError(AuthErrorTypes.EmptyCode);
		}

		const user = this.createCognitoUser(username);
		const forceAliasCreation =
			options && typeof options.forceAliasCreation === 'boolean'
				? options.forceAliasCreation
				: true;

		let clientMetadata;
		if (options && options.clientMetadata) {
			clientMetadata = options.clientMetadata;
		} else if (this._config.clientMetadata) {
			clientMetadata = this._config.clientMetadata;
		}
		return new Promise((resolve, reject) => {
			user.confirmRegistration(
				code,
				forceAliasCreation,
				(err, data) => {
					if (err) {
						reject(err);
					} else {
						dispatchAuthEvent(
							'confirmSignUp',
							data,
							`${username} has been confirmed successfully`
						);
						const autoSignIn = this.isTrueStorageValue('amplify-auto-sign-in');
						if (autoSignIn && !this.autoSignInInitiated) {
							dispatchAuthEvent(
								'autoSignIn_failure',
								null,
								AuthErrorTypes.AutoSignInError
							);
							this._storage.removeItem('amplify-auto-sign-in');
						}
						resolve(data);
					}
				},
				clientMetadata,
				getAuthUserAgentValue(AuthAction.ConfirmSignUp, customUserAgentDetails)
			);
		});
	}

	private isTrueStorageValue(value: string) {
		const item = this._storage.getItem(value);
		return item ? item === 'true' : false;
	}

	/**
	 * Resend the verification code
	 * @param {String} username - The username to be confirmed
	 * @param {ClientMetadata} clientMetadata - Metadata to be passed to Cognito Lambda triggers
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves code delivery details if successful
	 */
	public resendSignUp(
		username: string,
		clientMetadata: ClientMetaData = this._config.clientMetadata,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<any> {
		if (!this.userPool) {
			return this.rejectNoUserPool();
		}
		if (!username) {
			return this.rejectAuthError(AuthErrorTypes.EmptyUsername);
		}

		const user = this.createCognitoUser(username);
		return new Promise((resolve, reject) => {
			user.resendConfirmationCode(
				(err, data) => {
					if (err) {
						reject(err);
					} else {
						resolve(data);
					}
				},
				clientMetadata,
				getAuthUserAgentValue(AuthAction.ResendSignUp, customUserAgentDetails)
			);
		});
	}

	/**
	 * Sign in
	 * @param {String | SignInOpts} usernameOrSignInOpts - The username to be signed in or the sign in options
	 * @param {String} pw - The password of the username
	 * @param {ClientMetaData} clientMetadata - Client metadata for custom workflows
	 * @return - A promise resolves the CognitoUser
	 */
	public signIn(
		usernameOrSignInOpts: string | SignInOpts,
		pw?: string,
		clientMetadata: ClientMetaData = this._config.clientMetadata,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<CognitoUser | any> {
		if (!this.userPool) {
			return this.rejectNoUserPool();
		}

		let username = null;
		let password = null;
		let validationData = {};

		// for backward compatibility
		if (typeof usernameOrSignInOpts === 'string') {
			username = usernameOrSignInOpts;
			password = pw;
		} else if (isUsernamePasswordOpts(usernameOrSignInOpts)) {
			if (typeof pw !== 'undefined') {
				logger.warn(
					'The password should be defined under the first parameter object!'
				);
			}
			username = usernameOrSignInOpts.username;
			password = usernameOrSignInOpts.password;
			validationData = usernameOrSignInOpts.validationData;
		} else {
			return this.rejectAuthError(AuthErrorTypes.InvalidUsername);
		}
		if (!username) {
			return this.rejectAuthError(AuthErrorTypes.EmptyUsername);
		}
		const authDetails = new AuthenticationDetails({
			Username: username,
			Password: password,
			ValidationData: validationData,
			ClientMetadata: clientMetadata,
		});
		const userAgentDetails = getAuthUserAgentDetails(
			AuthAction.SignIn,
			customUserAgentDetails
		);
		if (password) {
			return this.signInWithPassword(authDetails, userAgentDetails);
		} else {
			return this.signInWithoutPassword(authDetails, userAgentDetails);
		}
	}

	/**
	 * Return an object with the authentication callbacks
	 * @param {InternalCognitoUser} user - the cognito user object
	 * @param {} resolve - function called when resolving the current step
	 * @param {} reject - function called when rejecting the current step
	 * @return - an object with the callback methods for user authentication
	 */
	private authCallbacks(
		user: InternalCognitoUser,
		resolve: (value?: InternalCognitoUser | any) => void,
		reject: (value?: any) => void,
		customUserAgentDetails: CustomUserAgentDetails
	): IAuthenticationCallback {
		const that = this;
		return {
			onSuccess: async session => {
				logger.debug(session);
				delete user['challengeName'];
				delete user['challengeParam'];
				try {
					await this.Credentials.clear();
					const cred = await this.Credentials.set(session, 'session');
					logger.debug('succeed to get cognito credentials', cred);
				} catch (e) {
					logger.debug('cannot get cognito credentials', e);
				} finally {
					try {
						// In order to get user attributes and MFA methods
						// We need to trigger currentUserPoolUser again
						const currentUser = await this._currentUserPoolUser(
							undefined,
							customUserAgentDetails
						);
						that.user = currentUser;
						dispatchAuthEvent(
							'signIn',
							currentUser,
							`A user ${user.getUsername()} has been signed in`
						);
						resolve(currentUser);
					} catch (e) {
						logger.error('Failed to get the signed in user', e);
						reject(e);
					}
				}
			},
			onFailure: err => {
				logger.debug('signIn failure', err);
				dispatchAuthEvent(
					'signIn_failure',
					err,
					`${user.getUsername()} failed to signin`
				);
				reject(err);
			},
			customChallenge: challengeParam => {
				logger.debug('signIn custom challenge answer required');
				user['challengeName'] = 'CUSTOM_CHALLENGE';
				user['challengeParam'] = challengeParam;
				resolve(user);
			},
			mfaRequired: (challengeName, challengeParam) => {
				logger.debug('signIn MFA required');
				user['challengeName'] = challengeName;
				user['challengeParam'] = challengeParam;
				resolve(user);
			},
			mfaSetup: (challengeName, challengeParam) => {
				logger.debug('signIn mfa setup', challengeName);
				user['challengeName'] = challengeName;
				user['challengeParam'] = challengeParam;
				resolve(user);
			},
			newPasswordRequired: (userAttributes, requiredAttributes) => {
				logger.debug('signIn new password');
				user['challengeName'] = 'NEW_PASSWORD_REQUIRED';
				user['challengeParam'] = {
					userAttributes,
					requiredAttributes,
				};
				resolve(user);
			},
			totpRequired: (challengeName, challengeParam) => {
				logger.debug('signIn totpRequired');
				user['challengeName'] = challengeName;
				user['challengeParam'] = challengeParam;
				resolve(user);
			},
			selectMFAType: (challengeName, challengeParam) => {
				logger.debug('signIn selectMFAType', challengeName);
				user['challengeName'] = challengeName;
				user['challengeParam'] = challengeParam;
				resolve(user);
			},
		};
	}

	/**
	 * Sign in with a password
	 * @private
	 * @param {AuthenticationDetails} authDetails - the user sign in data
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves the CognitoUser object if success or mfa required
	 */
	private signInWithPassword(
		authDetails: AuthenticationDetails,
		customUserAgentDetails: CustomUserAgentDetails
	): Promise<InternalCognitoUser | any> {
		if (this.pendingSignIn) {
			throw new Error('Pending sign-in attempt already in progress');
		}

		const user = this.createCognitoUser(authDetails.getUsername());

		this.pendingSignIn = new Promise((resolve, reject) => {
			user.authenticateUser(
				authDetails,
				this.authCallbacks(
					user,
					value => {
						this.pendingSignIn = null;
						resolve(value);
					},
					error => {
						this.pendingSignIn = null;
						reject(error);
					},
					customUserAgentDetails
				),
				getAmplifyUserAgent(customUserAgentDetails)
			);
		});

		return this.pendingSignIn;
	}

	/**
	 * Sign in without a password
	 * @private
	 * @param {AuthenticationDetails} authDetails - the user sign in data
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves the InternalCognitoUser object if success or mfa required
	 */
	private signInWithoutPassword(
		authDetails: AuthenticationDetails,
		customUserAgentDetails: CustomUserAgentDetails
	): Promise<InternalCognitoUser | any> {
		const user = this.createCognitoUser(authDetails.getUsername());
		user.setAuthenticationFlowType('CUSTOM_AUTH');

		return new Promise((resolve, reject) => {
			user.initiateAuth(
				authDetails,
				this.authCallbacks(user, resolve, reject, customUserAgentDetails),
				getAmplifyUserAgent(customUserAgentDetails)
			);
		});
	}

	/**
	 * This was previously used by an authenticated user to get MFAOptions,
	 * but no longer returns a meaningful response. Refer to the documentation for
	 * how to setup and use MFA: https://docs.amplify.aws/lib/auth/mfa/q/platform/js
	 * @deprecated
	 * @param {CognitoUser} user - the current user
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves the current preferred mfa option if success
	 */
	public getMFAOptions(
		user: CognitoUser | any,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<MFAOption[]> {
		const internalUser: InternalCognitoUser | any = user;

		return new Promise((res, rej) => {
			internalUser.getMFAOptions((err, mfaOptions) => {
				if (err) {
					logger.debug('get MFA Options failed', err);
					rej(err);
					return;
				}
				logger.debug('get MFA options success', mfaOptions);
				res(mfaOptions);
				return;
			}, getAuthUserAgentValue(AuthAction.GetMFAOptions, customUserAgentDetails));
		});
	}

	/**
	 * get preferred mfa method
	 * @param {CognitoUser} user - the current cognito user
	 * @param {GetPreferredMFAOpts} params - options for getting the current user preferred MFA
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 */
	public getPreferredMFA(
		user: CognitoUser | any,
		params?: GetPreferredMFAOpts,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<string> {
		const internalUser: InternalCognitoUser | any = user;
		const that = this;
		return new Promise((res, rej) => {
			const clientMetadata = this._config.clientMetadata; // TODO: verify behavior if this is override during signIn

			const bypassCache = params ? params.bypassCache : false;
			const userAgentValue = getAuthUserAgentValue(
				AuthAction.GetPreferredMFA,
				customUserAgentDetails
			);
			internalUser.getUserData(
				async (err, data) => {
					if (err) {
						logger.debug('getting preferred mfa failed', err);
						if (this.isSessionInvalid(err)) {
							try {
								await this.cleanUpInvalidSession(user, userAgentValue);
							} catch (cleanUpError) {
								rej(
									new Error(
										`Session is invalid due to: ${err.message} and failed to clean up invalid session: ${cleanUpError.message}`
									)
								);
								return;
							}
						}
						rej(err);
						return;
					}

					const mfaType = that._getMfaTypeFromUserData(data);
					if (!mfaType) {
						rej('invalid MFA Type');
						return;
					} else {
						res(mfaType);
						return;
					}
				},
				{ bypassCache, clientMetadata },
				userAgentValue
			);
		});
	}

	private _getMfaTypeFromUserData(data) {
		let ret = null;
		const preferredMFA = data.PreferredMfaSetting;
		// if the user has used Auth.setPreferredMFA() to setup the mfa type
		// then the "PreferredMfaSetting" would exist in the response
		if (preferredMFA) {
			ret = preferredMFA;
		} else {
			// if mfaList exists but empty, then its noMFA
			const mfaList = data.UserMFASettingList;
			if (!mfaList) {
				// if SMS was enabled by using Auth.enableSMS(),
				// the response would contain MFAOptions
				// as for now Cognito only supports for SMS, so we will say it is 'SMS_MFA'
				// if it does not exist, then it should be NOMFA
				const MFAOptions = data.MFAOptions;
				if (MFAOptions) {
					ret = 'SMS_MFA';
				} else {
					ret = 'NOMFA';
				}
			} else if (mfaList.length === 0) {
				ret = 'NOMFA';
			} else {
				logger.debug('invalid case for getPreferredMFA', data);
			}
		}
		return ret;
	}

	private _getUserData(
		user: InternalCognitoUser,
		params,
		userAgentValue: string
	) {
		return new Promise((res, rej) => {
			user.getUserData(
				async (err, data) => {
					if (err) {
						logger.debug('getting user data failed', err);
						if (this.isSessionInvalid(err)) {
							try {
								await this.cleanUpInvalidSession(user, userAgentValue);
							} catch (cleanUpError) {
								rej(
									new Error(
										`Session is invalid due to: ${err.message} and failed to clean up invalid session: ${cleanUpError.message}`
									)
								);
								return;
							}
						}
						rej(err);
						return;
					} else {
						res(data);
					}
				},
				params,
				userAgentValue
			);
		});
	}

	/**
	 * set preferred MFA method
	 * @param {CognitoUser} user - the current Cognito user
	 * @param {string} mfaMethod - preferred mfa method
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolve if success
	 */
	public async setPreferredMFA(
		user: CognitoUser | any,
		mfaMethod: 'TOTP' | 'SMS' | 'NOMFA' | 'SMS_MFA' | 'SOFTWARE_TOKEN_MFA',
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<string> {
		const internalUser: InternalCognitoUser | any = user;
		const userAgentValue = getAuthUserAgentValue(
			AuthAction.SetPreferredMFA,
			customUserAgentDetails
		);
		const clientMetadata = this._config.clientMetadata; // TODO: verify behavior if this is override during signIn

		const userData = await this._getUserData(
			user,
			{
				bypassCache: true,
				clientMetadata,
			},
			userAgentValue
		);
		let smsMfaSettings = null;
		let totpMfaSettings = null;

		switch (mfaMethod) {
			case 'TOTP':
			case 'SOFTWARE_TOKEN_MFA':
				totpMfaSettings = {
					PreferredMfa: true,
					Enabled: true,
				};
				break;
			case 'SMS':
			case 'SMS_MFA':
				smsMfaSettings = {
					PreferredMfa: true,
					Enabled: true,
				};
				break;
			case 'NOMFA':
				const mfaList = userData['UserMFASettingList'];
				const currentMFAType = await this._getMfaTypeFromUserData(userData);
				if (currentMFAType === 'NOMFA') {
					return Promise.resolve('No change for mfa type');
				} else if (currentMFAType === 'SMS_MFA') {
					smsMfaSettings = {
						PreferredMfa: false,
						Enabled: false,
					};
				} else if (currentMFAType === 'SOFTWARE_TOKEN_MFA') {
					totpMfaSettings = {
						PreferredMfa: false,
						Enabled: false,
					};
				} else {
					return this.rejectAuthError(AuthErrorTypes.InvalidMFA);
				}
				// if there is a UserMFASettingList in the response
				// we need to disable every mfa type in that list
				if (mfaList && mfaList.length !== 0) {
					// to disable SMS or TOTP if exists in that list
					mfaList.forEach(mfaType => {
						if (mfaType === 'SMS_MFA') {
							smsMfaSettings = {
								PreferredMfa: false,
								Enabled: false,
							};
						} else if (mfaType === 'SOFTWARE_TOKEN_MFA') {
							totpMfaSettings = {
								PreferredMfa: false,
								Enabled: false,
							};
						}
					});
				}
				break;
			default:
				logger.debug('no validmfa method provided');
				return this.rejectAuthError(AuthErrorTypes.NoMFA);
		}

		const that = this;
		return new Promise<string>((res, rej) => {
			internalUser.setUserMfaPreference(
				smsMfaSettings,
				totpMfaSettings,
				(err, result) => {
					if (err) {
						logger.debug('Set user mfa preference error', err);
						return rej(err);
					}
					logger.debug('Set user mfa success', result);
					logger.debug('Caching the latest user data into local');
					// cache the latest result into user data
					internalUser.getUserData(
						async (err, data) => {
							if (err) {
								logger.debug('getting user data failed', err);
								if (this.isSessionInvalid(err)) {
									try {
										await this.cleanUpInvalidSession(user, userAgentValue);
									} catch (cleanUpError) {
										rej(
											new Error(
												`Session is invalid due to: ${err.message} and failed to clean up invalid session: ${cleanUpError.message}`
											)
										);
										return;
									}
								}
								return rej(err);
							} else {
								return res(result);
							}
						},
						{
							bypassCache: true,
							clientMetadata,
						},
						userAgentValue
					);
				},
				userAgentValue
			);
		});
	}

	/**
	 * disable SMS
	 * @deprecated
	 * @param {CognitoUser} user - the current user
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves is success
	 */
	public disableSMS(
		user: CognitoUser,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<string> {
		const internalUser = user as InternalCognitoUser;

		return new Promise((res, rej) => {
			internalUser.disableMFA((err, data) => {
				if (err) {
					logger.debug('disable mfa failed', err);
					rej(err);
					return;
				}
				logger.debug('disable mfa succeed', data);
				res(data);
				return;
			}, getAuthUserAgentValue(AuthAction.DisableSMS, customUserAgentDetails));
		});
	}

	/**
	 * enable SMS
	 * @deprecated
	 * @param {CognitoUser} user - the current user
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves is success
	 */
	public enableSMS(
		user: CognitoUser,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<string> {
		const internalUser = user as InternalCognitoUser;

		return new Promise((res, rej) => {
			internalUser.enableMFA((err, data) => {
				if (err) {
					logger.debug('enable mfa failed', err);
					rej(err);
					return;
				}
				logger.debug('enable mfa succeed', data);
				res(data);
				return;
			}, getAuthUserAgentValue(AuthAction.EnableSMS, customUserAgentDetails));
		});
	}

	/**
	 * Setup TOTP
	 * @param {CognitoUser} user - the current user
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves with the secret code if success
	 */
	public setupTOTP(
		user: CognitoUser | any,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<string> {
		const internalUser: InternalCognitoUser | any = user;

		return new Promise((res, rej) => {
			internalUser.associateSoftwareToken(
				{
					onFailure: err => {
						logger.debug('associateSoftwareToken failed', err);
						rej(err);
						return;
					},
					associateSecretCode: secretCode => {
						logger.debug('associateSoftwareToken success', secretCode);
						res(secretCode);
						return;
					},
				},
				getAuthUserAgentValue(AuthAction.SetupTOTP, customUserAgentDetails)
			);
		});
	}

	/**
	 * verify TOTP setup
	 * @param {CognitoUser} user - the current user
	 * @param {string} challengeAnswer - challenge answer
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves is success
	 */
	public verifyTotpToken(
		user: CognitoUser | any,
		challengeAnswer: string,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<CognitoUserSession> {
		logger.debug('verification totp token', user, challengeAnswer);
		const internalUser: InternalCognitoUser | any = user;

		let signInUserSession;
		if (
			internalUser &&
			typeof internalUser.getSignInUserSession === 'function'
		) {
			signInUserSession = (user as InternalCognitoUser).getSignInUserSession();
		}
		const isLoggedIn = signInUserSession?.isValid();

		return new Promise((res, rej) => {
			internalUser.verifySoftwareToken(
				challengeAnswer,
				'My TOTP device',
				{
					onFailure: err => {
						logger.debug('verifyTotpToken failed', err);
						rej(err);
						return;
					},
					onSuccess: data => {
						if (!isLoggedIn) {
							dispatchAuthEvent(
								'signIn',
								internalUser,
								`A user ${internalUser.getUsername()} has been signed in`
							);
						}
						dispatchAuthEvent(
							'verify',
							internalUser,
							`A user ${internalUser.getUsername()} has been verified`
						);
						logger.debug('verifyTotpToken success', data);
						res(data);
						return;
					},
				},
				getAuthUserAgentValue(
					AuthAction.VerifyTotpToken,
					customUserAgentDetails
				)
			);
		});
	}

	/**
	 * Send MFA code to confirm sign in
	 * @param {Object} user - The CognitoUser object
	 * @param {String} code - The confirmation code
	 * @param {string} mfaType - optional mfaType: 'SMS_MFA' | 'SOFTWARE_TOKEN_MFA'
	 * @param {ClientMetaData} clientMetadata - optional client metadata defaults to config
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 */
	public confirmSignIn(
		user: CognitoUser | any,
		code: string,
		mfaType?: 'SMS_MFA' | 'SOFTWARE_TOKEN_MFA' | null,
		clientMetadata: ClientMetaData = this._config.clientMetadata,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<CognitoUser | any> {
		const internalUser: InternalCognitoUser | any = user;

		if (!code) {
			return this.rejectAuthError(AuthErrorTypes.EmptyCode);
		}

		const that = this;
		const userAgentDetails = getAuthUserAgentDetails(
			AuthAction.ConfirmSignIn,
			customUserAgentDetails
		);
		return new Promise((resolve, reject) => {
			internalUser.sendMFACode(
				code,
				{
					onSuccess: async session => {
						logger.debug(session);
						try {
							await this.Credentials.clear();
							const cred = await this.Credentials.set(session, 'session');
							logger.debug('succeed to get cognito credentials', cred);
						} catch (e) {
							logger.debug('cannot get cognito credentials', e);
						} finally {
							that.user = internalUser;
							try {
								const currentUser = await this._currentUserPoolUser(
									undefined,
									userAgentDetails
								);
								Object.assign(internalUser, {
									attributes: currentUser.attributes,
								});
							} catch (e) {
								logger.debug('cannot get updated Cognito User', e);
							}
							dispatchAuthEvent(
								'signIn',
								internalUser,
								`A user ${internalUser.getUsername()} has been signed in`
							);
							resolve(internalUser);
						}
					},
					onFailure: err => {
						logger.debug('confirm signIn failure', err);
						reject(err);
					},
				},
				mfaType,
				clientMetadata,
				getAmplifyUserAgent(userAgentDetails)
			);
		});
	}

	public completeNewPassword(
		user: CognitoUser | any,
		password: string,
		requiredAttributes: any = {},
		clientMetadata: ClientMetaData = this._config.clientMetadata,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<CognitoUser | any> {
		const internalUser: InternalCognitoUser | any = user;

		if (!password) {
			return this.rejectAuthError(AuthErrorTypes.EmptyPassword);
		}

		const that = this;
		return new Promise((resolve, reject) => {
			internalUser.completeNewPasswordChallenge(
				password,
				requiredAttributes,
				{
					onSuccess: async session => {
						logger.debug(session);
						try {
							await this.Credentials.clear();
							const cred = await this.Credentials.set(session, 'session');
							logger.debug('succeed to get cognito credentials', cred);
						} catch (e) {
							logger.debug('cannot get cognito credentials', e);
						} finally {
							that.user = internalUser;
							dispatchAuthEvent(
								'signIn',
								internalUser,
								`A user ${internalUser.getUsername()} has been signed in`
							);
							resolve(internalUser);
						}
					},
					onFailure: err => {
						logger.debug('completeNewPassword failure', err);
						dispatchAuthEvent(
							'completeNewPassword_failure',
							err,
							`${this.user} failed to complete the new password flow`
						);
						reject(err);
					},
					mfaRequired: (challengeName, challengeParam) => {
						logger.debug('signIn MFA required');
						internalUser['challengeName'] = challengeName;
						internalUser['challengeParam'] = challengeParam;
						resolve(internalUser);
					},
					mfaSetup: (challengeName, challengeParam) => {
						logger.debug('signIn mfa setup', challengeName);
						internalUser['challengeName'] = challengeName;
						internalUser['challengeParam'] = challengeParam;
						resolve(internalUser);
					},
					totpRequired: (challengeName, challengeParam) => {
						logger.debug('signIn mfa setup', challengeName);
						internalUser['challengeName'] = challengeName;
						internalUser['challengeParam'] = challengeParam;
						resolve(internalUser);
					},
				},
				clientMetadata,
				getAuthUserAgentValue(
					AuthAction.CompleteNewPassword,
					customUserAgentDetails
				)
			);
		});
	}

	/**
	 * Send the answer to a custom challenge
	 * @param {CognitoUser} user - The CognitoUser object
	 * @param {String} challengeResponses - The confirmation code
	 * @param {ClientMetaData} clientMetadata - optional client metadata defaults to config
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 *
	 */
	public sendCustomChallengeAnswer(
		user: CognitoUser | any,
		challengeResponses: string,
		clientMetadata: ClientMetaData = this._config.clientMetadata,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<CognitoUser | any> {
		const internalUser: InternalCognitoUser | any = user;

		if (!this.userPool) {
			return this.rejectNoUserPool();
		}
		if (!challengeResponses) {
			return this.rejectAuthError(AuthErrorTypes.EmptyChallengeResponse);
		}

		const that = this;
		const userAgentDetails = getAuthUserAgentDetails(
			AuthAction.SendCustomChallengeAnswer,
			customUserAgentDetails
		);
		return new Promise((resolve, reject) => {
			internalUser.sendCustomChallengeAnswer(
				challengeResponses,
				this.authCallbacks(internalUser, resolve, reject, userAgentDetails),
				clientMetadata,
				getAmplifyUserAgent(userAgentDetails)
			);
		});
	}

	/**
	 * Delete an authenticated users' attributes
	 * @param {CognitoUser} user - The currently logged in user object
	 * @param {string[]} attributeNames - Attributes to delete
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return {Promise}
	 **/
	public deleteUserAttributes(
		user: CognitoUser | any,
		attributeNames: string[],
		customUserAgentDetails?: CustomUserAgentDetails
	) {
		const internalUser: InternalCognitoUser | any = user;
		const that = this;
		const userAgentValue = getAuthUserAgentValue(
			AuthAction.DeleteUserAttributes,
			customUserAgentDetails
		);
		return new Promise((resolve, reject) => {
			that._userSession(userAgentValue, internalUser).then(session => {
				internalUser.deleteAttributes(
					attributeNames,
					(err, result) => {
						if (err) {
							return reject(err);
						} else {
							return resolve(result);
						}
					},
					userAgentValue
				);
			});
		});
	}

	/**
	 * Delete the current authenticated user
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return {Promise}
	 **/
	// TODO: Check return type void
	public async deleteUser(
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<string | void> {
		try {
			await this._storageSync;
		} catch (e) {
			logger.debug('Failed to sync cache info into memory', e);
			throw new Error(e);
		}

		const isSignedInHostedUI =
			this._oAuthHandler &&
			this._storage.getItem('amplify-signin-with-hostedUI') === 'true';

		return new Promise(async (res, rej) => {
			if (this.userPool) {
				const internalUser =
					this.userPool.getCurrentUser() as InternalCognitoUser;

				if (!internalUser) {
					logger.debug('Failed to get user from user pool');
					return rej(new Error('No current user.'));
				} else {
					const userAgentValue = getAuthUserAgentValue(
						AuthAction.DeleteUser,
						customUserAgentDetails
					);
					internalUser.getSession(async (err, session) => {
						if (err) {
							logger.debug('Failed to get the user session', err);
							if (this.isSessionInvalid(err)) {
								try {
									await this.cleanUpInvalidSession(
										internalUser,
										userAgentValue
									);
								} catch (cleanUpError) {
									rej(
										new Error(
											`Session is invalid due to: ${err.message} and failed to clean up invalid session: ${cleanUpError.message}`
										)
									);
									return;
								}
							}
							return rej(err);
						} else {
							internalUser.deleteUser(
								(err, result: string) => {
									if (err) {
										rej(err);
									} else {
										dispatchAuthEvent(
											'userDeleted',
											result,
											'The authenticated user has been deleted.'
										);
										internalUser.signOut(undefined, userAgentValue);
										this.user = null;
										try {
											this.cleanCachedItems(); // clean aws credentials
										} catch (e) {
											// TODO: change to rejects in refactor
											logger.debug('failed to clear cached items');
										}

										if (isSignedInHostedUI) {
											this.oAuthSignOutRedirect(res, rej);
										} else {
											dispatchAuthEvent(
												'signOut',
												this.user,
												`A user has been signed out`
											);
											res(result);
										}
									}
								},
								undefined,
								userAgentValue
							);
						}
					});
				}
			} else {
				logger.debug('no Congito User pool');
				rej(new Error('Cognito User pool does not exist'));
			}
		});
	}

	/**
	 * Update an authenticated users' attributes
	 * @param {CognitoUser} user - The currently logged in user object
	 * @param {object} attributes - attributes to update
	 * @param {ClientMetaData} clientMetadata - optional client metadata, defaults to config
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return {Promise}
	 **/
	public updateUserAttributes(
		user: CognitoUser | any,
		attributes: object,
		clientMetadata: ClientMetaData = this._config.clientMetadata,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<string> {
		const internalUser: InternalCognitoUser | any = user;
		const attributeList: ICognitoUserAttributeData[] = [];
		const that = this;
		const userAgentValue = getAuthUserAgentValue(
			AuthAction.UpdateUserAttributes,
			customUserAgentDetails
		);
		return new Promise((resolve, reject) => {
			that._userSession(userAgentValue, internalUser).then(session => {
				for (const key in attributes) {
					if (key !== 'sub' && key.indexOf('_verified') < 0) {
						const attr: ICognitoUserAttributeData = {
							Name: key,
							Value: attributes[key],
						};
						attributeList.push(attr);
					}
				}
				internalUser.updateAttributes(
					attributeList,
					(err, result, details) => {
						if (err) {
							dispatchAuthEvent(
								'updateUserAttributes_failure',
								err,
								'Failed to update attributes'
							);
							return reject(err);
						} else {
							const attrs = this.createUpdateAttributesResultList(
								attributes as Record<string, string>,
								details?.CodeDeliveryDetailsList
							);
							dispatchAuthEvent(
								'updateUserAttributes',
								attrs,
								'Attributes successfully updated'
							);
							return resolve(result);
						}
					},
					clientMetadata,
					userAgentValue
				);
			});
		});
	}

	private createUpdateAttributesResultList(
		attributes: Record<string, string>,
		codeDeliveryDetailsList?: CodeDeliveryDetails[]
	): Record<string, string> {
		const attrs = {};
		Object.keys(attributes).forEach(key => {
			attrs[key] = {
				isUpdated: true,
			};
			const codeDeliveryDetails = codeDeliveryDetailsList?.find(
				value => value.AttributeName === key
			);
			if (codeDeliveryDetails) {
				attrs[key].isUpdated = false;
				attrs[key].codeDeliveryDetails = codeDeliveryDetails;
			}
		});
		return attrs;
	}

	/**
	 * Return user attributes
	 * @param {Object} user - The CognitoUser object
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves to user attributes if success
	 */
	public userAttributes(
		user: CognitoUser | any,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<CognitoUserAttribute[]> {
		return this._userAttributes(user, customUserAgentDetails);
	}

	private _userAttributes(
		user: CognitoUser | any,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<CognitoUserAttribute[]> {
		const internalUser: InternalCognitoUser | any = user;
		const userAgentValue = getAuthUserAgentValue(
			AuthAction.UserAttributes,
			customUserAgentDetails
		);
		return new Promise((resolve, reject) => {
			this._userSession(userAgentValue, internalUser).then(session => {
				internalUser.getUserAttributes((err, attributes) => {
					if (err) {
						reject(err);
					} else {
						resolve(attributes);
					}
				}, userAgentValue);
			});
		});
	}

	public verifiedContact(
		user: CognitoUser | any,
		customUserAgentDetails?: CustomUserAgentDetails
	) {
		const that = this;
		return this._userAttributes(
			user,
			getAuthUserAgentDetails(
				AuthAction.VerifiedContact,
				customUserAgentDetails
			)
		).then(attributes => {
			const attrs = that.attributesToObject(attributes);
			const unverified = {};
			const verified = {};
			if (attrs['email']) {
				if (attrs['email_verified']) {
					verified['email'] = attrs['email'];
				} else {
					unverified['email'] = attrs['email'];
				}
			}
			if (attrs['phone_number']) {
				if (attrs['phone_number_verified']) {
					verified['phone_number'] = attrs['phone_number'];
				} else {
					unverified['phone_number'] = attrs['phone_number'];
				}
			}
			return {
				verified,
				unverified,
			};
		});
	}

	private isErrorWithMessage(err: any): err is { message: string } {
		return (
			typeof err === 'object' &&
			Object.prototype.hasOwnProperty.call(err, 'message')
		);
	}

	// Session revoked by another app
	private isTokenRevokedError(
		err: any
	): err is { message: 'Access Token has been revoked' } {
		return (
			this.isErrorWithMessage(err) &&
			err.message === 'Access Token has been revoked'
		);
	}

	private isRefreshTokenRevokedError(
		err: any
	): err is { message: 'Refresh Token has been revoked' } {
		return (
			this.isErrorWithMessage(err) &&
			err.message === 'Refresh Token has been revoked'
		);
	}

	private isUserDisabledError(
		err: any
	): err is { message: 'User is disabled.' } {
		return this.isErrorWithMessage(err) && err.message === 'User is disabled.';
	}

	private isUserDoesNotExistError(
		err: any
	): err is { message: 'User does not exist.' } {
		return (
			this.isErrorWithMessage(err) && err.message === 'User does not exist.'
		);
	}

	private isRefreshTokenExpiredError(
		err: any
	): err is { message: 'Refresh Token has expired' } {
		return (
			this.isErrorWithMessage(err) &&
			err.message === 'Refresh Token has expired'
		);
	}

	private isPasswordResetRequiredError(
		err: any
	): err is { message: 'Password reset required for the user' } {
		return (
			this.isErrorWithMessage(err) &&
			err.message === 'Password reset required for the user'
		);
	}

	private isSignedInHostedUI() {
		return (
			this._oAuthHandler &&
			this._storage.getItem('amplify-signin-with-hostedUI') === 'true'
		);
	}

	private isSessionInvalid(err: any) {
		return (
			this.isUserDisabledError(err) ||
			this.isUserDoesNotExistError(err) ||
			this.isTokenRevokedError(err) ||
			this.isRefreshTokenRevokedError(err) ||
			this.isRefreshTokenExpiredError(err) ||
			this.isPasswordResetRequiredError(err)
		);
	}

	private async cleanUpInvalidSession(
		internalUser: InternalCognitoUser,
		userAgentValue: string
	) {
		internalUser.signOut(undefined, userAgentValue);
		this.user = null;
		try {
			await this.cleanCachedItems(); // clean aws credentials
		} catch (e) {
			logger.debug('failed to clear cached items');
		}
		if (this.isSignedInHostedUI()) {
			return new Promise((res, rej) => {
				this.oAuthSignOutRedirect(res, rej);
			});
		} else {
			dispatchAuthEvent('signOut', this.user, `A user has been signed out`);
		}
	}

	/**
	 * Get current authenticated user
	 * @param {CurrentUserOpts} params - options for getting the current user
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves to current authenticated CognitoUser if success
	 */
	public currentUserPoolUser(
		params?: CurrentUserOpts,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<CognitoUser | any> {
		return this._currentUserPoolUser(params, customUserAgentDetails);
	}

	private _currentUserPoolUser(
		params?: CurrentUserOpts,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<CognitoUser | any> {
		if (!this.userPool) {
			return this.rejectNoUserPool();
		}

		return new Promise((res, rej) => {
			this._storageSync
				.then(async () => {
					if (this.isOAuthInProgress()) {
						logger.debug('OAuth signIn in progress, waiting for resolution...');

						await new Promise(res => {
							const timeoutId = setTimeout(() => {
								logger.debug('OAuth signIn in progress timeout');

								Hub.remove('auth', hostedUISignCallback);

								res();
							}, OAUTH_FLOW_MS_TIMEOUT);

							Hub.listen('auth', hostedUISignCallback);

							function hostedUISignCallback({ payload }) {
								const { event } = payload;

								if (
									event === 'cognitoHostedUI' ||
									event === 'cognitoHostedUI_failure'
								) {
									logger.debug(`OAuth signIn resolved: ${event}`);
									clearTimeout(timeoutId);

									Hub.remove('auth', hostedUISignCallback);

									res();
								}
							}
						});
					}

					const internalUser =
						this.userPool.getCurrentUser() as InternalCognitoUser;

					if (!internalUser) {
						logger.debug('Failed to get user from user pool');
						rej('No current user');
						return;
					}

					// refresh the session if the session expired.
					try {
						const userAgentValue = getAuthUserAgentValue(
							AuthAction.CurrentUserPoolUser,
							customUserAgentDetails
						);
						const session = await this._userSession(
							userAgentValue,
							internalUser
						);

						// get user data from Cognito
						const bypassCache = params ? params.bypassCache : false;

						if (bypassCache) {
							await this.Credentials.clear();
						}

						const clientMetadata = this._config.clientMetadata;

						// validate the token's scope first before calling this function
						const { scope = '' } = session.getAccessToken().decodePayload();
						if (scope.split(' ').includes(USER_ADMIN_SCOPE)) {
							internalUser.getUserData(
								async (err, data) => {
									if (err) {
										logger.debug('getting user data failed', err);
										if (this.isSessionInvalid(err)) {
											try {
												await this.cleanUpInvalidSession(
													internalUser,
													userAgentValue
												);
											} catch (cleanUpError) {
												rej(
													new Error(
														`Session is invalid due to: ${err.message} and failed to clean up invalid session: ${cleanUpError.message}`
													)
												);
												return;
											}
											rej(err);
										} else {
											res(internalUser);
										}
										return;
									}
									const preferredMFA = data.PreferredMfaSetting || 'NOMFA';
									const attributeList: CognitoUserAttribute[] = [];

									for (let i = 0; i < data.UserAttributes.length; i++) {
										const attribute = {
											Name: data.UserAttributes[i].Name,
											Value: data.UserAttributes[i].Value,
										};
										const userAttribute = new CognitoUserAttribute(attribute);
										attributeList.push(userAttribute);
									}

									const attributes = this.attributesToObject(attributeList);
									Object.assign(internalUser, { attributes, preferredMFA });
									return res(internalUser);
								},
								{ bypassCache, clientMetadata },
								userAgentValue
							);
						} else {
							logger.debug(
								`Unable to get the user data because the ${USER_ADMIN_SCOPE} ` +
									`is not in the scopes of the access token`
							);
							return res(internalUser);
						}
					} catch (err) {
						rej(err);
					}
				})
				.catch(e => {
					logger.debug('Failed to sync cache info into memory', e);
					return rej(e);
				});
		});
	}

	private isOAuthInProgress(): boolean {
		return this.oAuthFlowInProgress;
	}

	/**
	 * Get current authenticated user
	 * @param {CurrentUserOpts} - options for getting the current user
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves to current authenticated CognitoUser if success
	 */
	public currentAuthenticatedUser(
		params?: CurrentUserOpts,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<CognitoUser | any> {
		return this._currentAuthenticatedUser(params, customUserAgentDetails);
	}

	private async _currentAuthenticatedUser(
		params?: CurrentUserOpts,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<CognitoUser | any> {
		logger.debug('getting current authenticated user');
		let federatedUser = null;
		try {
			await this._storageSync;
		} catch (e) {
			logger.debug('Failed to sync cache info into memory', e);
			throw e;
		}

		try {
			const federatedInfo = JSON.parse(
				this._storage.getItem('aws-amplify-federatedInfo')
			);
			if (federatedInfo) {
				federatedUser = {
					...federatedInfo.user,
					token: federatedInfo.token,
				};
			}
		} catch (e) {
			logger.debug('cannot load federated user from auth storage');
		}

		if (federatedUser) {
			this.user = federatedUser;
			logger.debug('get current authenticated federated user', this.user);
			return this.user;
		} else {
			logger.debug('get current authenticated userpool user');
			let user = null;
			try {
				user = await this._currentUserPoolUser(
					params,
					getAuthUserAgentDetails(
						AuthAction.CurrentAuthenticatedUser,
						customUserAgentDetails
					)
				);
			} catch (e) {
				if (e === 'No userPool') {
					logger.error(
						'Cannot get the current user because the user pool is missing. ' +
							'Please make sure the Auth module is configured with a valid Cognito User Pool ID'
					);
				}
				logger.debug('The user is not authenticated by the error', e);
				return Promise.reject('The user is not authenticated');
			}
			this.user = user;
			return this.user;
		}
	}

	/**
	 * Get current user's session
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves to session object if success
	 */
	public currentSession(
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<CognitoUserSession> {
		return this._currentSession(customUserAgentDetails);
	}

	private _currentSession(
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<CognitoUserSession> {
		const that = this;
		const userAgentDetails = getAuthUserAgentDetails(
			AuthAction.CurrentSession,
			customUserAgentDetails
		);
		logger.debug('Getting current session');
		// Purposely not calling the reject method here because we don't need a console error
		if (!this.userPool) {
			return Promise.reject(new Error('No User Pool in the configuration.'));
		}

		return new Promise((res, rej) => {
			that
				._currentUserPoolUser(undefined, userAgentDetails)
				.then(user => {
					that
						._userSession(getAmplifyUserAgent(userAgentDetails), user)
						.then(session => {
							res(session);
							return;
						})
						.catch(e => {
							logger.debug('Failed to get the current session', e);
							rej(e);
							return;
						});
				})
				.catch(e => {
					logger.debug('Failed to get the current user', e);
					rej(e);
					return;
				});
		});
	}

	private async _userSession(
		userAgentValue: string,
		internalUser?: InternalCognitoUser
	): Promise<CognitoUserSession> {
		if (!internalUser) {
			logger.debug('the user is null');
			return this.rejectAuthError(AuthErrorTypes.NoUserSession);
		}
		const clientMetadata = this._config.clientMetadata;
		// Debouncing the concurrent userSession calls by caching the promise.
		// This solution assumes users will always call this function with the same CognitoUser instance.
		if (this.inflightSessionPromiseCounter === 0) {
			this.inflightSessionPromise = new Promise<CognitoUserSession>(
				(res, rej) => {
					internalUser.getSession(
						async (err, session) => {
							if (err) {
								logger.debug(
									'Failed to get the session from user',
									internalUser
								);
								if (this.isSessionInvalid(err)) {
									try {
										await this.cleanUpInvalidSession(
											internalUser,
											userAgentValue
										);
									} catch (cleanUpError) {
										rej(
											new Error(
												`Session is invalid due to: ${err.message} and failed to clean up invalid session: ${cleanUpError.message}`
											)
										);
										return;
									}
								}
								rej(err);
								return;
							} else {
								logger.debug('Succeed to get the user session', session);
								res(session);
								return;
							}
						},
						{ clientMetadata },
						userAgentValue
					);
				}
			);
		}
		this.inflightSessionPromiseCounter++;

		try {
			const userSession = await this.inflightSessionPromise;
			// Set private member. Avoid user.setSignInUserSession() to prevent excessive localstorage refresh.
			// @ts-ignore
			internalUser.signInUserSession = userSession;
			return userSession!;
		} finally {
			this.inflightSessionPromiseCounter--;
		}
	}

	/**
	 * Get the corresponding user session
	 * @param {Object} user - The CognitoUser object
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves to the session
	 */
	public userSession(
		user,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<CognitoUserSession> {
		return this._userSession(
			getAuthUserAgentValue(AuthAction.UserSession, customUserAgentDetails),
			user
		);
	}

	/**
	 * Get authenticated credentials of current user.
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves to be current user's credentials
	 */
	public async currentUserCredentials(
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<ICredentials> {
		logger.debug('Getting current user credentials');

		try {
			await this._storageSync;
		} catch (e) {
			logger.debug('Failed to sync cache info into memory', e);
			throw e;
		}

		// first to check whether there is federation info in the auth storage
		let federatedInfo = null;
		try {
			federatedInfo = JSON.parse(
				this._storage.getItem('aws-amplify-federatedInfo')
			);
		} catch (e) {
			logger.debug('failed to get or parse item aws-amplify-federatedInfo', e);
		}

		if (federatedInfo) {
			// refresh the jwt token here if necessary
			return this.Credentials.refreshFederatedToken(federatedInfo);
		} else {
			return this._currentSession(
				getAuthUserAgentDetails(
					AuthAction.CurrentUserCredentials,
					customUserAgentDetails
				)
			)
				.then(session => {
					logger.debug('getting session success', session);
					return this.Credentials.set(session, 'session');
				})
				.catch(() => {
					logger.debug('getting guest credentials');
					return this.Credentials.set(null, 'guest');
				});
		}
	}

	public currentCredentials(
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<ICredentials> {
		logger.debug('getting current credentials');
		return this.Credentials.get();
	}

	/**
	 * Initiate an attribute confirmation request
	 * @param {Object} user - The CognitoUser
	 * @param {Object} attr - The attributes to be verified
	 * @param {ClientMetaData} clientMetadata - optional client metadata, defaults to config
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves to callback data if success
	 */
	public verifyUserAttribute(
		user: CognitoUser | any,
		attr: string,
		clientMetadata: ClientMetaData = this._config.clientMetadata,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<void> {
		return this._verifyUserAttribute(
			user,
			attr,
			clientMetadata,
			customUserAgentDetails
		);
	}

	private _verifyUserAttribute(
		user: CognitoUser | any,
		attr: string,
		clientMetadata: ClientMetaData = this._config.clientMetadata,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<void> {
		const internalUser: InternalCognitoUser | any = user;

		return new Promise((resolve, reject) => {
			internalUser.getAttributeVerificationCode(
				attr,
				{
					onSuccess(success) {
						return resolve(success);
					},
					onFailure(err) {
						return reject(err);
					},
				},
				clientMetadata,
				getAuthUserAgentValue(
					AuthAction.VerifyUserAttribute,
					customUserAgentDetails
				)
			);
		});
	}

	/**
	 * Confirm an attribute using a confirmation code
	 * @param {Object} user - The CognitoUser
	 * @param {Object} attr - The attribute to be verified
	 * @param {String} code - The confirmation code
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves to callback data if success
	 */
	public verifyUserAttributeSubmit(
		user: CognitoUser | any,
		attr: string,
		code: string,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<string> {
		return this._verifyUserAttributeSubmit(
			user,
			attr,
			code,
			customUserAgentDetails
		);
	}

	private _verifyUserAttributeSubmit(
		user: CognitoUser | any,
		attr: string,
		code: string,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<string> {
		if (!code) {
			return this.rejectAuthError(AuthErrorTypes.EmptyCode);
		}
		const internalUser: InternalCognitoUser | any = user;

		return new Promise((resolve, reject) => {
			internalUser.verifyAttribute(
				attr,
				code,
				{
					onSuccess(data) {
						resolve(data);
						return;
					},
					onFailure(err) {
						reject(err);
						return;
					},
				},
				getAuthUserAgentValue(
					AuthAction.VerifyUserAttributeSubmit,
					customUserAgentDetails
				)
			);
		});
	}

	public verifyCurrentUserAttribute(
		attr: string,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<void> {
		const userAgentDetails = getAuthUserAgentDetails(
			AuthAction.VerifyCurrentUserAttribute,
			customUserAgentDetails
		);
		const that = this;
		return that
			._currentUserPoolUser(undefined, userAgentDetails)
			.then(user =>
				that._verifyUserAttribute(user, attr, undefined, userAgentDetails)
			);
	}

	/**
	 * Confirm current user's attribute using a confirmation code
	 * @param {Object} attr - The attribute to be verified
	 * @param {String} code - The confirmation code
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves to callback data if success
	 */
	verifyCurrentUserAttributeSubmit(
		attr: string,
		code: string,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<string> {
		const userAgentDetails = getAuthUserAgentDetails(
			AuthAction.VerifyCurrentUserAttributeSubmit,
			customUserAgentDetails
		);
		const that = this;
		return that
			._currentUserPoolUser(undefined, userAgentDetails)
			.then(user =>
				that._verifyUserAttributeSubmit(user, attr, code, userAgentDetails)
			);
	}

	private async cognitoIdentitySignOut(
		opts: SignOutOpts,
		internalUser: InternalCognitoUser | any,
		userAgentValue: string
	) {
		try {
			await this._storageSync;
		} catch (e) {
			logger.debug('Failed to sync cache info into memory', e);
			throw e;
		}

		const isSignedInHostedUI =
			this._oAuthHandler &&
			this._storage.getItem('amplify-signin-with-hostedUI') === 'true';

		return new Promise((res, rej) => {
			if (opts && opts.global) {
				logger.debug('user global sign out', internalUser);
				// in order to use global signout
				// we must validate the user as an authenticated user by using getSession
				const clientMetadata = this._config.clientMetadata; // TODO: verify behavior if this is override during signIn

				internalUser.getSession(
					async (err, result) => {
						if (err) {
							logger.debug('failed to get the user session', err);
							if (this.isSessionInvalid(err)) {
								try {
									await this.cleanUpInvalidSession(
										internalUser,
										userAgentValue
									);
								} catch (cleanUpError) {
									rej(
										new Error(
											`Session is invalid due to: ${err.message} and failed to clean up invalid session: ${cleanUpError.message}`
										)
									);
									return;
								}
							}
							return rej(err);
						}
						internalUser.globalSignOut(
							{
								onSuccess: data => {
									logger.debug('global sign out success');
									if (isSignedInHostedUI) {
										this.oAuthSignOutRedirect(res, rej);
									} else {
										return res();
									}
								},
								onFailure: err => {
									logger.debug('global sign out failed', err);
									return rej(err);
								},
							},
							userAgentValue
						);
					},
					{ clientMetadata },
					userAgentValue
				);
			} else {
				logger.debug('user sign out', internalUser);
				internalUser.signOut(() => {
					if (isSignedInHostedUI) {
						this.oAuthSignOutRedirect(res, rej);
					} else {
						return res();
					}
				}, userAgentValue);
			}
		});
	}

	private oAuthSignOutRedirect(
		resolve: () => void,
		reject: (reason?: any) => void
	) {
		const { isBrowser } = browserOrNode();

		if (isBrowser) {
			this.oAuthSignOutRedirectOrReject(reject);
		} else {
			this.oAuthSignOutAndResolve(resolve);
		}
	}

	private oAuthSignOutAndResolve(resolve: () => void) {
		this._oAuthHandler.signOut();
		resolve();
	}

	private oAuthSignOutRedirectOrReject(reject: (reason?: any) => void) {
		this._oAuthHandler.signOut(); // this method redirects url

		// App should be redirected to another url otherwise it will reject
		setTimeout(() => reject(Error('Signout timeout fail')), 3000);
	}

	/**
	 * Sign out method
	 * @param {SignOutOpts} opts - options for sign out
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolved if success
	 */
	public async signOut(
		opts?: SignOutOpts,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<any> {
		try {
			await this.cleanCachedItems();
		} catch (e) {
			logger.debug('failed to clear cached items');
		}

		if (this.userPool) {
			const internalUser =
				this.userPool.getCurrentUser() as InternalCognitoUser;
			if (internalUser) {
				await this.cognitoIdentitySignOut(
					opts,
					internalUser,
					getAuthUserAgentValue(AuthAction.SignOut, customUserAgentDetails)
				);
			} else {
				logger.debug('no current Cognito user');
			}
		} else {
			logger.debug('no Cognito User pool');
		}

		/**
		 * Note for future refactor - no reliable way to get username with
		 * Cognito User Pools vs Identity when federating with Social Providers
		 * This is why we need a well structured session object that can be inspected
		 * and information passed back in the message below for Hub dispatch
		 */
		dispatchAuthEvent('signOut', this.user, `A user has been signed out`);
		this.user = null;
	}

	private async cleanCachedItems() {
		// clear cognito cached item
		await this.Credentials.clear();
	}

	/**
	 * Change a password for an authenticated user
	 * @param {Object} user - The CognitoUser object
	 * @param {String} oldPassword - the current password
	 * @param {String} newPassword - the requested new password
	 * @param {ClientMetaData} clientMetadata - optional client metadata, defaults to config
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves if success
	 */
	public changePassword(
		user: CognitoUser | any,
		oldPassword: string,
		newPassword: string,
		clientMetadata: ClientMetaData = this._config.clientMetadata,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<'SUCCESS'> {
		const internalUser: InternalCognitoUser | any = user;
		const userAgentValue = getAuthUserAgentValue(
			AuthAction.ChangePassword,
			customUserAgentDetails
		);

		return new Promise((resolve, reject) => {
			this._userSession(userAgentValue, internalUser).then(session => {
				internalUser.changePassword(
					oldPassword,
					newPassword,
					(err, data) => {
						if (err) {
							logger.debug('change password failure', err);
							return reject(err);
						} else {
							return resolve(data);
						}
					},
					clientMetadata,
					userAgentValue
				);
			});
		});
	}

	/**
	 * Initiate a forgot password request
	 * @param {String} username - the username to change password
	 * @param {ClientMetaData} clientMetadata - optional client metadata, defaults to config
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise resolves if success
	 */
	public forgotPassword(
		username: string,
		clientMetadata: ClientMetaData = this._config.clientMetadata,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<any> {
		if (!this.userPool) {
			return this.rejectNoUserPool();
		}
		if (!username) {
			return this.rejectAuthError(AuthErrorTypes.EmptyUsername);
		}

		const internalUser = this.createCognitoUser(username);
		return new Promise((resolve, reject) => {
			internalUser.forgotPassword(
				{
					onSuccess: () => {
						resolve();
						return;
					},
					onFailure: err => {
						logger.debug('forgot password failure', err);
						dispatchAuthEvent(
							'forgotPassword_failure',
							err,
							`${username} forgotPassword failed`
						);
						reject(err);
						return;
					},
					inputVerificationCode: data => {
						dispatchAuthEvent(
							'forgotPassword',
							internalUser,
							`${username} has initiated forgot password flow`
						);
						resolve(data);
						return;
					},
				},
				clientMetadata,
				getAuthUserAgentValue(AuthAction.ForgotPassword, customUserAgentDetails)
			);
		});
	}

	/**
	 * Confirm a new password using a confirmation Code
	 * @param {String} username - The username
	 * @param {String} code - The confirmation code
	 * @param {String} password - The new password
	 * @param {ClientMetaData} clientMetadata - optional client metadata, defaults to config
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return - A promise that resolves if success
	 */
	public forgotPasswordSubmit(
		username: string,
		code: string,
		password: string,
		clientMetadata: ClientMetaData = this._config.clientMetadata,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<string> {
		if (!this.userPool) {
			return this.rejectNoUserPool();
		}
		if (!username) {
			return this.rejectAuthError(AuthErrorTypes.EmptyUsername);
		}
		if (!code) {
			return this.rejectAuthError(AuthErrorTypes.EmptyCode);
		}
		if (!password) {
			return this.rejectAuthError(AuthErrorTypes.EmptyPassword);
		}

		const internalUser = this.createCognitoUser(username);
		return new Promise((resolve, reject) => {
			internalUser.confirmPassword(
				code,
				password,
				{
					onSuccess: success => {
						dispatchAuthEvent(
							'forgotPasswordSubmit',
							internalUser,
							`${username} forgotPasswordSubmit successful`
						);
						resolve(success);
						return;
					},
					onFailure: err => {
						dispatchAuthEvent(
							'forgotPasswordSubmit_failure',
							err,
							`${username} forgotPasswordSubmit failed`
						);
						reject(err);
						return;
					},
				},
				clientMetadata,
				getAuthUserAgentValue(
					AuthAction.ForgotPasswordSubmit,
					customUserAgentDetails
				)
			);
		});
	}

	/**
	 * Get user information
	 * @async
	 * @param {CustomUserAgentDetails} customUserAgentDetails - Optional parameter to send user agent details
	 * @return {Object }- current User's information
	 */
	public async currentUserInfo(
		customUserAgentDetails?: CustomUserAgentDetails
	) {
		const source = this.Credentials.getCredSource();
		const userAgentDetails = getAuthUserAgentDetails(
			AuthAction.CurrentUserInfo,
			customUserAgentDetails
		);

		if (!source || source === 'aws' || source === 'userPool') {
			const internalUser: InternalCognitoUser = await this._currentUserPoolUser(
				undefined,
				userAgentDetails
			).catch(err => logger.error(err));
			if (!internalUser) {
				return null;
			}

			try {
				const attributes = await this._userAttributes(
					internalUser,
					userAgentDetails
				);
				const userAttrs: object = this.attributesToObject(attributes);
				let credentials = null;
				try {
					credentials = await this.currentCredentials();
				} catch (e) {
					logger.debug(
						'Failed to retrieve credentials while getting current user info',
						e
					);
				}

				const info = {
					id: credentials ? credentials.identityId : undefined,
					username: internalUser.getUsername(),
					attributes: userAttrs,
				};
				return info;
			} catch (err) {
				logger.error('currentUserInfo error', err);
				return {};
			}
		}

		if (source === 'federated') {
			const user = this.user;
			return user ? user : {};
		}
	}

	public async federatedSignIn(
		providerOrOptions:
			| LegacyProvider
			| FederatedSignInOptions
			| FederatedSignInOptionsCustom,
		response?: FederatedResponse,
		user?: FederatedUser,
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<ICredentials> {
		if (!this._config.identityPoolId && !this._config.userPoolId) {
			throw new Error(
				`Federation requires either a User Pool or Identity Pool in config`
			);
		}

		// Ensure backwards compatability
		if (typeof providerOrOptions === 'undefined') {
			if (this._config.identityPoolId && !this._config.userPoolId) {
				throw new Error(
					`Federation with Identity Pools requires tokens passed as arguments`
				);
			}
		}

		if (
			isFederatedSignInOptions(providerOrOptions) ||
			isFederatedSignInOptionsCustom(providerOrOptions) ||
			hasCustomState(providerOrOptions) ||
			typeof providerOrOptions === 'undefined'
		) {
			const options = providerOrOptions || {
				provider: CognitoHostedUIIdentityProvider.Cognito,
			};
			const provider = isFederatedSignInOptions(options)
				? options.provider
				: (options as FederatedSignInOptionsCustom).customProvider;

			const customState = isFederatedSignInOptions(options)
				? options.customState
				: (options as FederatedSignInOptionsCustom).customState;

			if (this._config.userPoolId) {
				const client_id = isCognitoHostedOpts(this._config.oauth)
					? this._config.userPoolWebClientId
					: this._config.oauth.clientID;
				/*Note: Invenstigate automatically adding trailing slash */
				const redirect_uri = isCognitoHostedOpts(this._config.oauth)
					? this._config.oauth.redirectSignIn
					: this._config.oauth.redirectUri;

				this._storage.setItem(
					'aws-amplify-federatedUserAgent',
					getAuthUserAgentValue(
						AuthAction.FederatedSignIn,
						customUserAgentDetails
					)
				);

				this._oAuthHandler.oauthSignIn(
					this._config.oauth.responseType,
					this._config.oauth.domain,
					redirect_uri,
					client_id,
					provider,
					customState
				);
			}
		} else {
			const provider = providerOrOptions;
			// To check if the user is already logged in
			try {
				const loggedInUser = JSON.stringify(
					JSON.parse(this._storage.getItem('aws-amplify-federatedInfo')).user
				);
				if (loggedInUser) {
					logger.warn(`There is already a signed in user: ${loggedInUser} in your app.
																	You should not call Auth.federatedSignIn method again as it may cause unexpected behavior.`);
				}
			} catch (e) {}

			const { token, identity_id, expires_at } = response;
			// Because this.Credentials.set would update the user info with identity id
			// So we need to retrieve the user again.
			const credentials = await this.Credentials.set(
				{ provider, token, identity_id, user, expires_at },
				'federation'
			);
			const currentUser = await this._currentAuthenticatedUser();
			dispatchAuthEvent(
				'signIn',
				currentUser,
				`A user ${currentUser.username} has been signed in`
			);
			logger.debug('federated sign in credentials', credentials);
			return credentials;
		}
	}

	/**
	 * Used to complete the OAuth flow with or without the Cognito Hosted UI
	 * @param {String} URL - optional parameter for customers to pass in the response URL
	 */
	private async _handleAuthResponse(URL?: string) {
		if (this.oAuthFlowInProgress) {
			logger.debug(`Skipping URL ${URL} current flow in progress`);
			return;
		}

		try {
			this.oAuthFlowInProgress = true;
			if (!this._config.userPoolId) {
				throw new Error(
					`OAuth responses require a User Pool defined in config`
				);
			}

			dispatchAuthEvent(
				'parsingCallbackUrl',
				{ url: URL },
				`The callback url is being parsed`
			);

			const currentUrl =
				URL || (browserOrNode().isBrowser ? window.location.href : '');

			const hasCodeOrError = !!(parse(currentUrl).query || '')
				.split('&')
				.map(entry => entry.split('='))
				.find(([k]) => k === 'code' || k === 'error');

			const hasTokenOrError = !!(parse(currentUrl).hash || '#')
				.substr(1)
				.split('&')
				.map(entry => entry.split('='))
				.find(([k]) => k === 'access_token' || k === 'error');

			if (hasCodeOrError || hasTokenOrError) {
				this._storage.setItem('amplify-redirected-from-hosted-ui', 'true');
				const userAgentValue =
					this._storage.getItem('aws-amplify-federatedUserAgent') || undefined;
				this._storage.removeItem('aws-amplify-federatedUserAgent');
				try {
					const { accessToken, idToken, refreshToken, state } =
						await this._oAuthHandler.handleAuthResponse(
							currentUrl,
							userAgentValue
						);
					const session = new CognitoUserSession({
						IdToken: new CognitoIdToken({ IdToken: idToken }),
						RefreshToken: new CognitoRefreshToken({
							RefreshToken: refreshToken,
						}),
						AccessToken: new CognitoAccessToken({
							AccessToken: accessToken,
						}),
					});

					let credentials;
					// Get AWS Credentials & store if Identity Pool is defined
					if (this._config.identityPoolId) {
						credentials = await this.Credentials.set(session, 'session');
						logger.debug('AWS credentials', credentials);
					}

					/*
				Prior to the request we do sign the custom state along with the state we set. This check will verify
				if there is a dash indicated when setting custom state from the request. If a dash is contained
				then there is custom state present on the state string.
				*/
					const isCustomStateIncluded = /-/.test(state);

					/*
				The following is to create a user for the Cognito Identity SDK to store the tokens
				When we remove this SDK later that logic will have to be centralized in our new version
				*/
					//#region
					const currentUser = this.createCognitoUser(
						session.getIdToken().decodePayload()['cognito:username']
					);

					// This calls cacheTokens() in Cognito SDK
					currentUser.setSignInUserSession(session);

					if (window && typeof window.history !== 'undefined') {
						window.history.replaceState(
							{},
							null,
							(this._config.oauth as AwsCognitoOAuthOpts).redirectSignIn
						);
					}

					dispatchAuthEvent(
						'signIn',
						currentUser,
						`A user ${currentUser.getUsername()} has been signed in`
					);
					dispatchAuthEvent(
						'cognitoHostedUI',
						currentUser,
						`A user ${currentUser.getUsername()} has been signed in via Cognito Hosted UI`
					);

					if (isCustomStateIncluded) {
						const customState = state.split('-').splice(1).join('-');

						dispatchAuthEvent(
							'customOAuthState',
							urlSafeDecode(customState),
							`State for user ${currentUser.getUsername()}`
						);
					}
					//#endregion

					return credentials;
				} catch (err) {
					logger.debug('Error in cognito hosted auth response', err);

					// Just like a successful handling of `?code`, replace the window history to "dispose" of the `code`.
					// Otherwise, reloading the page will throw errors as the `code` has already been spent.
					if (window && typeof window.history !== 'undefined') {
						window.history.replaceState(
							{},
							null,
							(this._config.oauth as AwsCognitoOAuthOpts).redirectSignIn
						);
					}

					dispatchAuthEvent(
						'signIn_failure',
						err,
						`The OAuth response flow failed`
					);
					dispatchAuthEvent(
						'cognitoHostedUI_failure',
						err,
						`A failure occurred when returning to the Cognito Hosted UI`
					);
					dispatchAuthEvent(
						'customState_failure',
						err,
						`A failure occurred when returning state`
					);
				}
			}
		} finally {
			this.oAuthFlowInProgress = false;
		}
	}

	/**
	 * Compact version of credentials
	 * @param {Object} credentials
	 * @return {Object} - Credentials
	 */
	public essentialCredentials(credentials): ICredentials {
		return {
			accessKeyId: credentials.accessKeyId,
			sessionToken: credentials.sessionToken,
			secretAccessKey: credentials.secretAccessKey,
			identityId: credentials.identityId,
			authenticated: credentials.authenticated,
		};
	}

	private attributesToObject(attributes) {
		const obj = {};
		if (attributes) {
			attributes.map(attribute => {
				if (
					attribute.Name === 'email_verified' ||
					attribute.Name === 'phone_number_verified'
				) {
					obj[attribute.Name] =
						this.isTruthyString(attribute.Value) || attribute.Value === true;
				} else {
					obj[attribute.Name] = attribute.Value;
				}
			});
		}
		return obj;
	}

	private isTruthyString(value: any): boolean {
		return (
			typeof value.toLowerCase === 'function' && value.toLowerCase() === 'true'
		);
	}

	private createCognitoUser(username: string): InternalCognitoUser {
		const userData: ICognitoUserData = {
			Username: username,
			Pool: this.userPool,
		};
		userData.Storage = this._storage;

		const { authenticationFlowType } = this._config;

		const internalUser = new InternalCognitoUser(userData);
		if (authenticationFlowType) {
			internalUser.setAuthenticationFlowType(authenticationFlowType);
		}
		return internalUser;
	}

	private _isValidAuthStorage(obj) {
		// We need to check if the obj has the functions of Storage
		return (
			!!obj &&
			typeof obj.getItem === 'function' &&
			typeof obj.setItem === 'function' &&
			typeof obj.removeItem === 'function' &&
			typeof obj.clear === 'function'
		);
	}

	private noUserPoolErrorHandler(config: AuthOptions): AuthErrorTypes {
		if (config) {
			if (!config.userPoolId || !config.identityPoolId) {
				return AuthErrorTypes.MissingAuthConfig;
			}
		}
		return AuthErrorTypes.NoConfig;
	}

	private rejectAuthError(type: AuthErrorTypes): Promise<never> {
		return Promise.reject(new AuthError(type));
	}

	private rejectNoUserPool(): Promise<never> {
		const type = this.noUserPoolErrorHandler(this._config);
		return Promise.reject(new NoUserPoolError(type));
	}

	public async rememberDevice(
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<string | AuthError> {
		let internalUser: InternalCognitoUser | any;
		const userAgentDetails = getAuthUserAgentDetails(
			AuthAction.RememberDevice,
			customUserAgentDetails
		);

		try {
			internalUser = await this._currentUserPoolUser(
				undefined,
				userAgentDetails
			);
		} catch (error) {
			logger.debug('The user is not authenticated by the error', error);
			return Promise.reject('The user is not authenticated');
		}

		internalUser.getCachedDeviceKeyAndPassword();
		return new Promise((res, rej) => {
			internalUser.setDeviceStatusRemembered(
				{
					onSuccess: data => {
						res(data);
					},
					onFailure: err => {
						if (err.code === 'InvalidParameterException') {
							rej(new AuthError(AuthErrorTypes.DeviceConfig));
						} else if (err.code === 'NetworkError') {
							rej(new AuthError(AuthErrorTypes.NetworkError));
						} else {
							rej(err);
						}
					},
				},
				getAmplifyUserAgent(userAgentDetails)
			);
		});
	}

	public async forgetDevice(
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<void> {
		let internalUser: InternalCognitoUser | any;
		const userAgentDetails = getAuthUserAgentDetails(
			AuthAction.ForgetDevice,
			customUserAgentDetails
		);

		try {
			internalUser = await this._currentUserPoolUser(
				undefined,
				userAgentDetails
			);
		} catch (error) {
			logger.debug('The user is not authenticated by the error', error);
			return Promise.reject('The user is not authenticated');
		}

		internalUser.getCachedDeviceKeyAndPassword();
		return new Promise((res, rej) => {
			internalUser.forgetDevice(
				{
					onSuccess: data => {
						res(data);
					},
					onFailure: err => {
						if (err.code === 'InvalidParameterException') {
							rej(new AuthError(AuthErrorTypes.DeviceConfig));
						} else if (err.code === 'NetworkError') {
							rej(new AuthError(AuthErrorTypes.NetworkError));
						} else {
							rej(err);
						}
					},
				},
				getAmplifyUserAgent(userAgentDetails)
			);
		});
	}

	public async fetchDevices(
		customUserAgentDetails?: CustomUserAgentDetails
	): Promise<IAuthDevice[]> {
		let internalUser: InternalCognitoUser | any;
		const userAgentDetails = getAuthUserAgentDetails(
			AuthAction.FetchDevices,
			customUserAgentDetails
		);

		try {
			internalUser = await this._currentUserPoolUser(
				undefined,
				userAgentDetails
			);
		} catch (error) {
			logger.debug('The user is not authenticated by the error', error);
			throw new Error('The user is not authenticated');
		}

		internalUser.getCachedDeviceKeyAndPassword();
		return new Promise((res, rej) => {
			const cb = {
				onSuccess(data) {
					const deviceList: IAuthDevice[] = data.Devices.map(device => {
						const deviceName =
							device.DeviceAttributes.find(
								({ Name }) => Name === 'device_name'
							) || {};

						const deviceInfo: IAuthDevice = {
							id: device.DeviceKey,
							name: deviceName.Value,
						};
						return deviceInfo;
					});
					res(deviceList);
				},
				onFailure: err => {
					if (err.code === 'InvalidParameterException') {
						rej(new AuthError(AuthErrorTypes.DeviceConfig));
					} else if (err.code === 'NetworkError') {
						rej(new AuthError(AuthErrorTypes.NetworkError));
					} else {
						rej(err);
					}
				},
			};
			internalUser.listDevices(
				MAX_DEVICES,
				null,
				cb,
				getAmplifyUserAgent(userAgentDetails)
			);
		});
	}
}

export const InternalAuth = new InternalAuthClass(null);
Amplify.register(InternalAuth);