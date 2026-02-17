import { signReceipt } from './v5_crypto';

// Rate limiting placeholder for future use
const RATE_LIMIT = 10; 
const ipTracker = new Map<string, number[]>();

export default {
    async fetch(request: Request, env: any): Promise<Response> {
        // CORS Headers: Critical for your website to communicate with this worker
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, x-api-key, X-Oracle-Key",
            "Content-Type": "application/json",
        };

        // Handle CORS Pre-flight
        if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

        const url = new URL(request.url);

        // 1. ROUTE: /v5/demo (Audit Finding #5)
        // Provides a signed sample so developers can test verification instantly.
        if (url.pathname === "/v5/demo") {
            try {
                const receipt = await signReceipt(
                    "DEMO_MARKET", 
                    "OPEN", 
                    "SYSTEM", 
                    env
                );
                return new Response(JSON.stringify(receipt, null, 2), { headers: corsHeaders });
            } catch (err: any) {
                return new Response(JSON.stringify({ error: "DEMO_UNAVAILABLE" }), { status: 500, headers: corsHeaders });
            }
        }

        // 2. ROUTE: /v5/status
        if (url.pathname === "/v5/status") {
            const mic = url.searchParams.get("mic") || "XNYS";
            
            try {
                // TIER 1: Normal Operation
                // In production, you would insert your DB logic here to determine if "OPEN" or "CLOSED"
                const receipt = await signReceipt(
                    mic, 
                    "CLOSED", // Static for Beta
                    "SCHEDULE", 
                    env
                );

                return new Response(JSON.stringify(receipt), { headers: corsHeaders });

            } catch (err: any) {
                // FAIL-CLOSED SAFETY NET (Audit Finding #2)
                // Log with specific Tier 1 tag for Cloudflare log filtering
                console.error(`ORACLE_TIER_1_FAILURE: ${err.message}`);
                
                try {
                    // TIER 2: The Safety Receipt
                    const safeReceipt = await signReceipt(
                        mic,
                        "UNKNOWN", // Safety State
                        "SYSTEM",  // System Source
                        env
                    );
                    
                    return new Response(JSON.stringify(safeReceipt), { headers: corsHeaders });

                } catch (criticalError: any) {
                    // TIER 3: Catastrophic (Likely Private Key missing or corrupt)
                    console.error(`ORACLE_TIER_2_CATASTROPHIC: ${criticalError.message}`);
                    return new Response(JSON.stringify({
                        error: "CRITICAL_FAILURE",
                        message: "Oracle signature system offline."
                    }), { status: 500, headers: corsHeaders });
                }
            }
        }

        // 3. Default Route (Home / Health Check)
        return new Response(JSON.stringify({ 
            message: "Headless Oracle V5 Beta is Live",
            status: "OPERATIONAL",
            routes: {
                status: "/v5/status?mic=XNYS",
                demo: "/v5/demo"
            },
            docs: "https://headlessoracle.com/docs.html" 
        }), { headers: corsHeaders });
    },
};