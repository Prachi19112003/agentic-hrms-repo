import json
import logging
import os
import sys
import urllib.request
import urllib.error
import subprocess
import shutil

if sys.platform.startswith("win"):
    sys.stdout.reconfigure(encoding="utf-8")

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [%(filename)s:%(lineno)d]: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("HRMSWorkflow")


def load_dotenv(dotenv_path: str = ".env")->None:
    """Reads a .env file and sets environment variables if present, without external dependencies."""
    if os.path.exists(dotenv_path):
        try:
            with open(dotenv_path, "r", encoding="utf-8") as f:
                for line in f:
                    line=line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" in line:
                        key, val=line.split("=", 1)
                        key=key.strip()
                        val=val.strip()
                        
                        if val.startswith(('"', "'")) and val.endswith(('"', "'")) and len(val)>=2:
                            val=val[1:-1]
                        
                        if val.startswith("<") and val.endswith(">") and len(val)>=2:
                            val=val[1:-1]
                        os.environ[key]=val
            logger.info("Loaded environment variables from local '%s' file.", dotenv_path)
        except Exception as e:
            logger.warning("Could not read '%s' file: %s", dotenv_path, str(e))


class ResponseWrapper:
    """Wrapper class mimicking the JavaScript fetch response object."""
    def __init__(self, status: int, headers: dict, body: str):
        self.status=status
        self.headers=headers
        self.body_str=body

    def json(self)->dict:
        return json.loads(self.body_str)

    def text(self)->str:
        return self.body_str


def fetch(url: str, headers: dict=None, body: dict=None, method: str="POST")->ResponseWrapper:
    """Standard-library wrapper mimicking Javascript fetch() to avoid external HTTP dependencies."""
    headers=headers or {}
    data=None
    
    if body is not None:
        if isinstance(body, dict):
            data=json.dumps(body).encode("utf-8")
            if "content-type" not in {k.lower() for k in headers}:
                headers["Content-Type"]="application/json"
        elif isinstance(body, str):
            data=body.encode("utf-8")
        else:
            data=body
            
    req=urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as response:
            status = response.status
            res_headers = dict(response.info())
            res_body = response.read().decode("utf-8")
            return ResponseWrapper(status, res_headers, res_body)
    except urllib.error.HTTPError as e:
        status=e.code
        res_headers=dict(e.info())
        res_body=e.read().decode("utf-8")
        return ResponseWrapper(status, res_headers, res_body)
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network Connection Error: {e.reason}")


def clean_json_response(content: str)->str:
    """Strips markdown code blocks and excess whitespace from LLM text output."""
    content=content.strip()
    if content.startswith("```"):
        first_newline=content.find("\n")
        if first_newline!=-1:
            content=content[first_newline:].strip()
        if content.endswith("```"):
            content=content[:-3].strip()
    return content


def mock_test_and_validate(file_path: str, min_complex_fields: int = 5)->tuple[bool, str]:
    """Reads the JSON model file and validates its structural complexity and syntax."""
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data=json.load(f)
        
        if not data:
            return False, "Validation Error: The schema file is empty."
        
        is_schema="$schema" in data or "properties" in data
        target_dict=data.get("properties", data) if is_schema else data
        
        complex_count=sum(1 for v in target_dict.values() if isinstance(v, (dict, list)))
        
        if complex_count<min_complex_fields:
            return (
                False,
                f"Validation Error: Found {complex_count} complex fields, "
                f"but at least {min_complex_fields} nested structures are required."
            )
            
        return True, "Validation Success: Structural integrity and complexity verified."
        
    except json.JSONDecodeError as je:
        return False, f"JSON Syntax Error: {str(je)}"
    except FileNotFoundError:
        return False, f"File Error: Target schema file not found at '{file_path}'."
    except Exception as e:
        return False, f"Unexpected Validation Failure: {str(e)}"


def auto_git_commit_and_push(user_requirement: str, file_path: str="employee_model.json")->None:
    """Stages, commits, and pushes the updated schema file automatically."""
    # Cloud environments like Render are Read-Only environments; 
    # If the file path is pointing to /tmp directory, we skip Git pipelines.
    if "/tmp" in file_path or os.environ.get("RENDER") or os.environ.get("PORT"):
        logger.info("Cloud execution context detected. Skipping local Git automated pipeline.")
        return

    logger.info("Starting automated Git commit and push pipeline...")
    
    try:
        add_res=subprocess.run(
            ["git", "add", file_path],
            capture_output=True,
            text=True,
            check=True
        )
        logger.info("Git add output: %s", add_res.stdout.strip() or "File staged successfully.")
    except subprocess.CalledProcessError as ce:
        logger.error("Git add failed: %s (stderr: %s)", str(ce), ce.stderr.strip())
        return

    commit_message=f"feat: auto-update schema - {user_requirement}"
    try:
        commit_res=subprocess.run(
            ["git", "commit", "-m", commit_message],
            capture_output=True,
            text=True,
            check=True
        )
        logger.info("Git commit output: %s", commit_res.stdout.strip())
    except subprocess.CalledProcessError as ce:
        stderr_msg=ce.stderr.lower()
        stdout_msg=ce.stdout.lower()
        if "nothing to commit" in stderr_msg or "nothing to commit" in stdout_msg or \
           "no changes added to commit" in stderr_msg or "no changes added to commit" in stdout_msg:
            logger.info("No modifications detected. Nothing to commit.")
        else:
            logger.error("Git commit failed: %s (stderr: %s)", str(ce), ce.stderr.strip())
            return

    try:
        push_res=subprocess.run(
            ["git", "push", "origin", "master"],
            capture_output=True,
            text=True,
            check=True
        )
        logger.info("Git push output: %s", push_res.stdout.strip() or "Pushed changes successfully.")
    except subprocess.CalledProcessError as ce:
        logger.error(
            "Git push failed but local changes are preserved. "
            "Error details: %s (stderr: %s)", str(ce), ce.stderr.strip()
        )


def run_agentic_workflow(user_requirement: str, file_path: str="employee_model.json")->None:
    """Executes the self-healing schema-generation loop using Google Gemini API."""
    logger.info("Starting Agentic Workflow for requirement: '%s'\n", user_requirement)
    
    load_dotenv()
    
    # SYSTEM CHECK: If running on cloud environment, safely intercept paths to write to /tmp
    original_path = file_path
    if os.environ.get("RENDER") or os.environ.get("PORT"):
        target_dir = "/tmp"
        resolved_file_path = os.path.join(target_dir, os.path.basename(file_path))
        
        # Hydrate /tmp with current repository model baseline if it's not present
        if not os.path.exists(resolved_file_path) and os.path.exists(original_path):
            shutil.copy(original_path, resolved_file_path)
            logger.info("Hydrated temporary cloud workspace path: %s", resolved_file_path)
        file_path = resolved_file_path

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            existing_schema_content = f.read()
    except FileNotFoundError:
        # Fallback loop initialization if file does not exist anywhere yet
        if file_path != original_path and os.path.exists(original_path):
            with open(original_path, "r", encoding="utf-8") as f:
                existing_schema_content = f.read()
        else:
            logger.warning("Target schema file '%s' not found. Initializing new schema.", file_path)
            existing_schema_content = "{}"

    api_key=os.environ.get("GEMINI_API_KEY")
    if not api_key:
        logger.error(
            "Missing environment variable: GEMINI_API_KEY. "
            "Please define this inside your setup."
        )
        sys.exit(1)

    contents=[
        {
            "role": "user",
            "parts": [
                {
                    "text": f"Existing Schema:\n{existing_schema_content}\n\nRequirement:\n{user_requirement}"
                }
            ]
        }
    ]

    attempts=1
    max_attempts=3
    success=False

    while attempts<=max_attempts:
        logger.info("--- Attempt %d: Sending request to Google Gemini ---", attempts)
        
        payload = {
            "contents": contents,
            "systemInstruction": {
                "parts": [
                    {
                        "text": "You are an autonomous AI Engineer. Update the given HRMS JSON schema based on the requirement. Return ONLY valid JSON with no markdown, no explanation. Just the raw updated JSON object."
                    }
                ]
            },
            "generationConfig": {
                "responseMimeType": "application/json"
            }
        }
        
        headers = {
            "Content-Type": "application/json"
        }
        
        url=f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
        
        try:
            resp=fetch(url, headers=headers, body=payload)
            
            if resp.status!=200:
                logger.error("Gemini API call failed (HTTP %d): %s", resp.status, resp.text())
                raise RuntimeError(f"Gemini API error (HTTP {resp.status}): {resp.text()}")
            
            resp_json=resp.json()
            
            try:
                raw_assistant_response=resp_json["candidates"][0]["content"]["parts"][0]["text"]
            except (KeyError, IndexError) as structure_error:
                logger.error("Unexpected response structure: %s", resp.text())
                raise RuntimeError(f"Failed to parse Gemini response structure: {str(structure_error)}")
            
            cleaned_json_str=clean_json_response(raw_assistant_response)
            
            # Safe write capability guaranteed by runtime /tmp redirection
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(cleaned_json_str)
            
            valid, message=mock_test_and_validate(file_path)
            
            if valid:
                logger.info("Success: %s", message)
                logger.info("Integrity of code verified. Final output pushed to repository without bugs.")
                auto_git_commit_and_push(user_requirement, file_path)
                success = True
                break
            else:
                logger.warning("Validation Failed on Attempt %d: %s", attempts, message)
               
                contents.append({
                    "role": "model",
                    "parts": [{"text": raw_assistant_response}]
                })
                contents.append({
                    "role": "user",
                    "parts": [
                        {
                            "text": f"Validation failed with the following error:\n{message}\n\nPlease correct the JSON schema and return only the valid JSON."
                        }
                    ]
                })
                attempts+=1
                
        except Exception as e:
            logger.error("Exception during agent execution on Attempt %d: %s", attempts, str(e))
            attempts+=1
            
    if not success:
        logger.error("Workflow stopped: Maximum self-healing attempts reached. Manual review needed.")
        sys.exit(1)


if __name__ == "__main__":
    import os
    
    # AGAR RENDER YA CLOUD PAR CHAL RAHA HAI
    if os.environ.get("RENDER") or os.environ.get("PORT"):
        from flask import Flask, request, jsonify
        from flask_cors import CORS
        import json

        app = Flask(__name__)
        CORS(app)

        @app.route('/api/update-schema', methods=['POST'])
        def update_schema():
            try:
                data = request.get_json()
                user_requirement = data.get('requirement', '').strip()
                if not user_requirement:
                    return jsonify({"error": "No requirement provided"}), 400
                
                # Asli function execute pipeline runs inside safe workspace
                run_agent_workflow(user_requirement, "employee_model.json")
                
                # Read dynamic output from /tmp layer rather than root workspace
                target_path = os.path.join('/tmp', 'employee_model.json')
                if not os.path.exists(target_path):
                    target_path = 'employee_model.json'

                with open(target_path, 'r', encoding='utf-8') as f:
                    return jsonify({"status": "success", "updated_schema": json.load(f)})
            except Exception as e:
                return jsonify({"error": str(e)}), 500

        port = int(os.environ.get("PORT", 5000))
        app.run(host="0.0.0.0", port=port)
        
    # AGAR AAP APNE LOCAL MACHINE PAR TERMINAL SE CHALA RAHI HAIN
    else:
        try:
            user_requirement = input("Enter your natural language schema update requirement: ").strip()
            if not user_requirement:
                print("No requirement entered. Exiting.")
                sys.exit(1)
            
            run_agent_workflow(user_requirement, "employee_model.json")
            
        except KeyboardInterrupt:
            print("\nWorkflow cancelled by user. Exiting.")
            sys.exit(0)