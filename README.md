# LLM Cost Autopilot

LLM Cost Autopilot helps an AI app choose the least expensive model that can still do a request well. It looks at the task, budget, needed features, and quality target, then picks a model and can move to a stronger one if the first answer is not good enough.

I built the routing rules, model list, cost estimates, quality checks, provider connection, API, tests, and local browser console with Node.js. It also includes a mock provider, so people can try the system without using a paid AI account.
