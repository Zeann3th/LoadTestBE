import { parentPort, workerData } from "worker_threads";
import { RunnerService } from "../runner/runner.service";
import { CredentialService } from "./credential.service";

const { ccu, duration, rampUpTime, nodes, input, runId, sharedCredentialBuffer, totalCcu } = workerData;

const startTime = Date.now();
const endTime = startTime + duration * 1000;
const credentialsManager = new CredentialService([], totalCcu, sharedCredentialBuffer);
const abortController = new AbortController();
let stopped = false;
let activeUsers = 0;
let totalRequests = 0;
let totalErrors = 0;

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

const randomDelay = async (base: number, variance: number) =>
    await delay(base + Math.floor(Math.random() * variance));

const startProgressReporting = () => {
    const progressInterval = setInterval(() => {
        if (stopped) {
            clearInterval(progressInterval);
            return;
        }

        const timeRemaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));

        parentPort?.postMessage({
            type: "info",
            payload: {
                message: `[Worker] Progress: ${activeUsers} active users, ${timeRemaining}s remaining, ${totalRequests} requests, ${totalErrors} errors`
            }
        });
    }, 10000);

    return progressInterval;
};

const spawnUser = async (): Promise<void> => {
    activeUsers++;
    const runner = new RunnerService();
    const credentials = credentialsManager.acquire();
    let data = JSON.parse(JSON.stringify(input));
    data = { ...credentials, ...data };

    try {
        while (!stopped && Date.now() < endTime) {
            for (const node of nodes) {
                if (stopped || Date.now() >= endTime || abortController.signal.aborted) break;

                let statusCode: number = 500;
                let responseTime: number = 0;
                let error: any = null;
                let hasError = false;

                try {
                    const { data: runnerData, response } = await runner.run(
                        node,
                        data,
                        abortController.signal
                    );
                    data = runnerData;
                    statusCode = response.status;
                    responseTime = response.latency;

                    if (statusCode >= 400) {
                        hasError = true;
                        totalErrors++;
                    }

                    totalRequests++;
                } catch (err: any) {
                    if (err.name === 'AbortError' || abortController.signal.aborted) break;

                    error = err;
                    hasError = true;
                    totalErrors++;
                    totalRequests++;
                } finally {
                    if (!abortController.signal.aborted) {
                        const message = {
                            type: "log",
                            payload: {
                                runId,
                                endpointId: node.id,
                                statusCode,
                                responseTime,
                                error: hasError ? (error ? error.message : `HTTP ${statusCode}`) : null,
                                createdAt: new Date().toISOString(),
                            }
                        };
                        parentPort?.postMessage(message);
                    }
                }
            }

            if (!stopped && !abortController.signal.aborted && Date.now() < endTime) {
                await randomDelay(500, 1000);
            }

            if (stopped || Date.now() >= endTime || abortController.signal.aborted) break;
        }
    } catch (err: any) {
        parentPort?.postMessage({
            type: "info",
            payload: { message: `[Worker] User session ended: ${err.message}` }
        });
    } finally {
        activeUsers--;
    }
}

const run = async (): Promise<void> => {
    parentPort?.postMessage({
        type: "info",
        payload: { message: `[Worker] Starting ${ccu} concurrent users for ${duration}s` }
    });

    const progressInterval = startProgressReporting();

    const users: Promise<void>[] = [];

    for (let i = 0; i < ccu; i++) {
        const delayTime = Math.floor((i / ccu) * rampUpTime * 1000);
        users.push(
            delay(delayTime)
                .then(() => spawnUser())
                .catch((err: any) => {
                    parentPort?.postMessage({
                        type: "info",
                        payload: { message: `[Worker] User ${i + 1} failed: ${err.message}` }
                    });
                })
        );
    }

    const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
            stopped = true;
            parentPort?.postMessage({
                type: "info",
                payload: { message: `[Worker] Duration timeout reached (${duration}s). Stopping users...` }
            });
            resolve();
        }, duration * 1000);
    });

    await timeoutPromise;

    parentPort?.postMessage({
        type: "info",
        payload: { message: `[Worker] Timeout reached. Aborting all requests and cleaning up...` }
    });

    abortController.abort();

    clearInterval(progressInterval);

    await Promise.allSettled(users);

    await delay(1000);

    parentPort?.postMessage({
        type: "done",
        payload: {
            message: `[Worker] Completed. Total requests: ${totalRequests}, Errors: ${totalErrors}`,
            totalRequests,
            totalErrors
        }
    });

    setTimeout(() => {
        process.exit(0);
    }, 100);
}

run()
    .then(() => process.exit(0))
    .catch((err: any) => {
        parentPort?.postMessage({
            type: "info",
            payload: { message: `[Worker] Worker crashed: ${err.message}` }
        });
        process.exit(1);
    });