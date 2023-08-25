import { verify } from '@indent/webhook';
import type { ApplyUpdateResponse, Event, PullUpdateResponse, Resource } from '@indent/types';
import { App } from 'octokit';

export interface Env {
	INDENT_WEBHOOK_SECRET: string;
	GITHUB_APP_ID: string;
	GITHUB_APP_INSTALL_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_ORG: string;
}

export enum StatusCode {
	OK = 0,
	CANCELLED = 1,
	UNKNOWN = 2,
	INVALID_ARGUMENT = 3,
	DEADLINE_EXCEEDED = 4,
	NOT_FOUND = 5,
	ALREADY_EXISTS = 6,
	PERMISSION_DENIED = 7,
	RESOURCE_EXHAUSTED = 8,
	FAILED_PRECONDITION = 9,
	ABORTED = 10,
	OUT_OF_RANGE = 11,
	UNIMPLEMENTED = 12,
	INTERNAL = 13,
	UNAVAILABLE = 14,
	DATA_LOSS = 15,
	UNAUTHENTICATED = 16,
}

const withOctokit = async (env: Env) => {
	const app = new App({
		appId: env.GITHUB_APP_ID,
		privateKey: env.GITHUB_APP_PRIVATE_KEY,
	});

	return await app.getInstallationOctokit(Number.parseInt(env.GITHUB_APP_INSTALL_ID));
};

const ORG_KIND = `github.v1.Organization`;

async function handlePull(kinds: string[], env: Env): Promise<PullUpdateResponse> {
	const octokit = await withOctokit(env);

	if (!kinds.includes(ORG_KIND)) {
		return {};
	}

	const {
		data: { name, company, description, id },
	} = await octokit.rest.orgs.get({ org: env.GITHUB_ORG });

	return {
		resources: [
			{
				id: id.toString(),
				kind: ORG_KIND,
				displayName: name,
				labels: {
					'github/id': id.toString(),
					'github/company': company ?? '',
					'github/slug': name ?? '',
					'github/description': description ?? '',
					timestamp: new Date().toISOString(),
				},
			},
		],
	};
}

const getGithubIdFromResources = (resources: Resource[], kind: string): string | undefined => {
	return resources.filter((r) => r.kind && r.kind.toLowerCase().includes(kind.toLowerCase())).map((r) => r.labels!['github/id'])[0];
};

const getGithubOrgFromResources = (resources: Resource[], kind: string) => {
	return resources.filter((r) => r.kind?.toLowerCase().includes(kind.toLowerCase())).map((r) => r.labels!['github/slug'])[0];
};

async function handleApplyUpdate(events: Event[], env: Env): Promise<ApplyUpdateResponse> {
	const octokit = await withOctokit(env);
	const auditEvent = events.find((e) => /grant|revoke/.test(e.event));
	if (!auditEvent) {
		console.log('received non-access related events');
		return {
			status: {},
		};
	}

	const { event, resources, actor } = auditEvent;
	const role = event === 'access/grant' ? 'admin' : 'member';
	const user = getGithubIdFromResources(resources!, 'user') ?? (actor!.labels ?? {})['github/id'];
	const org = getGithubOrgFromResources(resources!, ORG_KIND);

	if (!user) {
		console.error('missing user id');
		return {
			status: {
				code: StatusCode.FAILED_PRECONDITION,
				details: { errorData: 'could not get github user id' },
			},
		};
	}

	if (!org) {
		console.error('missing org id');
		return {
			status: {
				code: StatusCode.FAILED_PRECONDITION,
				details: { errorData: 'could not get github organization id' },
			},
		};
	}

	try {
		const {
			data: { role: userRole },
		} = await octokit.rest.orgs.getMembershipForUser({
			username: user,
			org,
		});

		if (userRole === role) {
			console.error(`desired role: ${userRole}, current role: ${role}`);
			return {
				status: {
					code: StatusCode.FAILED_PRECONDITION,
					details: { errorData: 'user is already organization admin' },
				},
			};
		}

		await octokit.rest.orgs.setMembershipForUser({
			username: user,
			org,
			role,
		});
	} catch (e) {
		console.error('could not set membership');
		console.error(e);
		return {
			status: {
				code: StatusCode.INTERNAL,
				details: { errorData: e!.toString() },
			},
		};
	}
	return { status: {} };
}

const normalizeHeaders = (request: Request): { [key: string]: string | string[] } => {
	const headers: { [key: string]: string | string[] } = {};
	for (const [k, v] of request.headers.entries()) {
		if (headers[k] === undefined) {
			headers[k] = v;
			continue;
		}

		if (typeof headers[k] === 'string') {
			headers[k] = [headers[k] as string, v];
		} else {
			(headers[k] as string[]).push(v);
		}
	}

	return headers;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const headers = normalizeHeaders(request);
		const bodyText = await request.text();

		try {
			await verify({
				secret: env.INDENT_WEBHOOK_SECRET,
				headers,
				body: bodyText,
			});
		} catch (e) {
			console.error('@indent/webhook.verify() failed');
			console.error(e);
			return new Response('invalid auth', { status: 500 });
		}

		const body = JSON.parse(bodyText);
		if (body.kinds !== undefined) {
			return new Response(JSON.stringify(await handlePull(body.kinds as string[], env)), {
				headers: {
					'content-type': 'application/json; charset=utf-8',
				},
			});
		}

		if (body.events !== undefined) {
			const res = await handleApplyUpdate(body.events as Event[], env);

			return new Response(JSON.stringify(res), {
				headers: {
					'content-type': 'application/json; charset=utf-8',
				},
				status: !res.status?.code ? 200 : 500,
			});
		}

		return new Response('unknown request', { status: 500 });
	},
};