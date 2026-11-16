#!/bin/sh
# gh-aw Codex three-Secret postprocessor: AI_API_KEY, AI_API_MODEL, AI_API_URL.
# Runtime: POSIX sh + awk + standard Unix tools, including mktemp and tail -c.
# No Node.js, Python, jq, yq, npm install, network request, or Git operation.
#
# Usage:
#   gh aw compile .github/workflows/repo-assist.md
#   sh scripts/patch_ghaw_codex_secrets.sh .github/workflows/repo-assist.lock.yml
#   gh aw lint .github/workflows/repo-assist.lock.yml
#   git diff --check
#
# Source Markdown: merge this engine into BOTH the main engine and
# safe-outputs.threat-detection.engine. Keep your existing triggers/tools/outputs.
#   engine:
#     id: codex
#     model-provider: openai
#     model: ghaw-placeholder-model
#     env:
#       CODEX_API_KEY: __GH_AW_PATCH_API_KEY__
#       OPENAI_API_KEY: __GH_AW_PATCH_API_KEY__
#       GH_AW_PRIVATE_OPENAI_URL: __GH_AW_PATCH_API_URL__
#       OPENAI_BASE_URL_ENV: GH_AW_PRIVATE_OPENAI_URL
# For gh-aw v1.2.2, set features.gh-aw-detection: false in the top-level
# Markdown frontmatter to select the supported inline detector. This does not
# disable safe-outputs.threat-detection. Use a Boolean false, without quotes.
# Also set sandbox.agent.model-fallback: false. Remove old model/endpoint
# overrides, including engine.api-target and engine.env.OPENAI_BASE_URL.
# Remove --model/-m from engine.args in both phases; let engine.model select it.
# The generated model argument can precede or follow "exec". Both documented
# gh-aw forms are accepted; other shell forms are reported as unrecognized.
# Do not put real values or a private host in Markdown or network.allowed.
# CODEX_API_KEY / OPENAI_API_KEY are env names, NOT additional GitHub Secrets.
# Both AWF CLI and images must support
# --openai-base-url-env. AWF accepts HTTPS/default port 443 without credentials,
# query, or fragment for this private-endpoint option.
#
# Only gh-aw-generated block YAML is supported, not arbitrary YAML. Unknown
# layouts, conflicting settings, aliases, and non-empty flow collections fail.
# LF and CRLF are preserved; mixed endings or a missing final LF are rejected.
# The metadata header stays unchanged. The script replaces placeholder env
# values (including job-level GH_AW_ENGINE_MODEL), checks preflight/main/detection
# inputs, adds the private AWF flag,
# adds all three values to existing redaction steps, and updates manifest.secrets.
# Secret references are never inserted into run scripts. Unexpected placeholders
# outside supported env entries cause a failure with all remaining line numbers
# and marker names, without printing the contents of those lines.
# Missing targets cause a failure.
# Reapply after compile/update/upgrade. gh aw run --push may recompile.
# This cannot remove addresses already present elsewhere or in Git history.
# No user workflow, live API, or AWF container was exercised for this artifact.
#
# References:
# https://github.github.com/gh-aw/setup/cli/
# https://github.github.com/gh-aw-firewall/reference/cli-reference/
# https://github.com/github/gh-aw/issues/41929

set -eu
LC_ALL=C
export LC_ALL

die() { printf 'ERROR: %s\n' "$*" >&2; exit 2; }
usage() {
    cat <<'HELP'
Usage: sh patch_ghaw_codex_secrets.sh FILE.lock.yml [options]

  --check         Do not modify the input; exit 1 if patching is required
  --agent-only    Allow missing detection; still patch any existing detector
  --help          Show this help

Exit: 0 = patched/already patched; 1 = check found missing patch; 2 = error.
Reapply after every compile. Review and commit the result yourself.
HELP
}

check=0
agent_only=0
lock_file=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --help|-h) usage; exit 0 ;;
        --check) check=1 ;;
        --agent-only) agent_only=1 ;;
        --)
            shift
            [ "$#" -eq 1 ] && [ -z "$lock_file" ] ||
                die 'Expected exactly one file after --'
            lock_file=$1
            break
            ;;
        -*) die 'Unrecognized option; use --help' ;;
        *)
            [ -z "$lock_file" ] || die 'Expected one lock file path'
            lock_file=$1
            ;;
    esac
    shift
done
[ -n "$lock_file" ] || die 'Missing lock file path; use --help'
case "$lock_file" in /*) ;; *) lock_file=./$lock_file ;; esac
[ -f "$lock_file" ] && [ ! -L "$lock_file" ] ||
    die 'Input must be a regular, non-symlink file'
for utility in awk mktemp cp cmp mv rm cat tail; do
    command -v "$utility" >/dev/null 2>&1 || die "Missing utility: $utility"
done

parent=${lock_file%/*}
work_dir=$(mktemp -d "$parent/.ghaw-private-endpoint.XXXXXXXX") ||
    die 'Cannot create temporary directory next to input'
cleanup() { rm -rf "$work_dir"; }
trap cleanup 0
trap 'exit 2' HUP INT TERM
cp -p "$lock_file" "$work_dir/original" || die 'Cannot snapshot input'
[ -s "$work_dir/original" ] || die 'Input is empty'
last_byte=$(tail -c 1 "$work_dir/original") || die 'Cannot check final newline'
[ -z "$last_byte" ] || die 'Expected generated YAML ending with LF'

cat > "$work_dir/patch.awk" <<'AWK'
function fail(message) { print "ERROR: " message > error_file; bad=1; exit 2 }
function require(ok, message) { if (!ok) fail(message) }
function trim(s) { sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
function scalar(s,    q,out,i,c) {
    s=trim(s); q=substr(s,1,1)
    if (q=="\"" || q=="\047") {
        out=""
        for (i=2;i<=length(s);i++) {
            c=substr(s,i,1)
            if (c==q) {
                if (q=="\047" && substr(s,i+1,1)==q) { out=out q; i++; continue }
                require(substr(s,i+1) ~ /^[ \t]*(#.*)?$/, "Unsupported quoted scalar")
                return out
            }
            require(!(q=="\"" && c=="\\"), "Escaped YAML scalar is unsupported")
            out=out c
        }
        fail("Unterminated quoted scalar")
    }
    sub(/[ \t]+#.*/,"",s)
    require(s !~ /^[&*!\[\]{},|>]/ && s !~ /:[ \t]/, "Unsupported YAML scalar")
    return trim(s)
}
# Validate JSON headers and record spans of top-level members.
# Values are preserved verbatim; escaped object keys are deliberately rejected.
function jspace() { while (substr(J,JP,1) ~ /^[ \t\r\n]$/) JP++ }
function jstring(    start,c,e,h) {
    require(substr(J,JP,1)=="\"", "Invalid JSON string")
    start=JP++
    while (JP<=length(J)) {
        c=substr(J,JP++,1)
        if (c=="\"") return substr(J,start,JP-start)
        require(c !~ /[[:cntrl:]]/, "Control character in JSON string")
        if (c=="\\") {
            e=substr(J,JP++,1)
            if (e=="u") {
                h=substr(J,JP,4)
                require(length(h)==4 && h !~ /[^0-9a-fA-F]/, "Invalid JSON escape")
                JP+=4
            } else require(e ~ /^["\\\/bfnrt]$/, "Invalid JSON escape")
        }
    }
    fail("Unterminated JSON string")
}
function jvalue(depth,    c,obj,key,start,type,token) {
    require(depth<64, "JSON nesting is unsupported")
    jspace(); c=substr(J,JP,1)
    if (c=="\"") { jstring(); return "string" }
    if (c=="{") {
        obj=++JO; JP++; jspace()
        if (substr(J,JP,1)=="}") { JP++; return "object" }
        while (1) {
            token=jstring()
            require(index(token,"\\")==0, "Escaped JSON object keys are unsupported")
            key=substr(token,2,length(token)-2)
            require(!((obj SUBSEP key) in JK), "Duplicate JSON object key")
            JK[obj,key]=1; jspace()
            require(substr(J,JP++,1)==":", "Invalid JSON object")
            jspace(); start=JP; type=jvalue(depth+1)
            if (depth==0) { JA[key]=start; JZ[key]=JP-1; JT[key]=type }
            jspace(); c=substr(J,JP++,1)
            if (c=="}") return "object"
            require(c==",", "Invalid JSON object delimiter"); jspace()
        }
    }
    if (c=="[") {
        JP++; jspace()
        if (substr(J,JP,1)=="]") { JP++; return "array" }
        while (1) {
            jvalue(depth+1); jspace(); c=substr(J,JP++,1)
            if (c=="]") return "array"
            require(c==",", "Invalid JSON array delimiter")
        }
    }
    if (match(substr(J,JP),/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/)) {
        JP+=RLENGTH; return "number"
    }
    if (substr(J,JP,4)=="true" || substr(J,JP,4)=="null") {
        JP+=4; return "literal"
    }
    if (substr(J,JP,5)=="false") { JP+=5; return "literal" }
    fail("Invalid JSON value")
}
function json(s,    k) {
    for (k in JA) delete JA[k]
    for (k in JZ) delete JZ[k]
    for (k in JT) delete JT[k]
    for (k in JK) delete JK[k]
    J=s; JP=1; JO=0
    require(jvalue(0)=="object", "Header must be a JSON object")
    jspace(); require(JP>length(J), "Trailing text after JSON header")
}
function member(key) { return substr(J,JA[key],JZ[key]-JA[key]+1) }
function patch_manifest(line,    s,part,name,count,changed,i,j,tmp,out,prefix) {
    prefix="# gh-aw-manifest: "
    json(substr(L[line],length(prefix)+1))
    require(member("version")=="1" && JT["secrets"]=="array", "Unsupported manifest")
    s=trim(member("secrets")); s=trim(substr(s,2,length(s)-2)); count=0; changed=0
    while (length(s)) {
        require(match(s,/^"[A-Za-z_][A-Za-z0-9_]*"/), "Unsupported manifest Secret name")
        part=substr(s,1,RLENGTH); name=substr(part,2,length(part)-2)
        require(!(name in inventory), "Duplicate Secret in manifest")
        inventory[name]=1
        if (name=="CODEX_API_KEY" || name=="OPENAI_API_KEY") changed=1
        else names[++count]=name
        s=trim(substr(s,RLENGTH+1))
        if (length(s)) {
            require(substr(s,1,1)==",", "Invalid manifest secrets array")
            s=trim(substr(s,2)); require(length(s)>0, "Invalid manifest secrets array")
        }
    }
    for (i=1;i<=3;i++) if (!(required_secrets[i] in inventory)) {
        names[++count]=required_secrets[i]; changed=1
    }
    if (!changed) return
    for (i=2;i<=count;i++) {
        tmp=names[i]; j=i-1
        while (j>0 && names[j]>tmp) { names[j+1]=names[j]; j-- }
        names[j+1]=tmp
    }
    out="["
    for (i=1;i<=count;i++) out=out (i>1?",":"") "\"" names[i] "\""
    L[line]=prefix substr(J,1,JA["secrets"]-1) out "]" substr(J,JZ["secrets"]+1)
}
function block_map(line,label) {
    require(line && !B[line] && scalar(V[line])=="", label " must use block layout")
}
function set_value(line,value) {
    require(line && !B[line], "Expected single-line environment value")
    L[line]=substr(L[line],1,D[line]) K[line] ": " value
    V[line]=value
}
function patch_job_env(start,stop,    i,k) {
    block_map(start,"Job env")
    for (i=start+1;i<stop;i++) if (T[i]) {
        if (D[i]<=4) break
        require(D[i]==6 && !Q[i] && K[i]!="", "Unsupported job env")
        k=K[i]
        require(!((start SUBSEP k) in job_env_keys), "Duplicate job environment key")
        job_env_keys[start,k]=1
        context[i]="jobs." K[job] ".env." k
        # gh-aw v1.2.2 emits an explicit engine.model as a quoted value here.
        # Only handle the compiler-owned model field and its entire value.
        if (k=="GH_AW_ENGINE_MODEL" && index(V[i],model_marker)) {
            require(!B[i] && scalar(V[i])==model_marker,
                "Job model placeholder must be the whole env value at line " i)
            set_value(i,model_ref)
        }
    }
}
function env_value(key) {
    require(key in E, "Missing env " key "; check the Markdown placeholders and recompile")
    require(!B[E[key]], "Block-valued env " key " is unsupported")
    return scalar(V[E[key]])
}
function read_env(start,stop,    line,i,k) {
    for (k in E) delete E[k]
    first_env=0; line=S["env"]
    if (!line) return
    block_map(line,"Step env")
    for (i=line+1;i<stop;i++) if (T[i]) {
        if (D[i]<=8) break
        require(D[i]==10 && !Q[i] && K[i]!="", "Unsupported step env")
        require(!(K[i] in E), "Duplicate environment key")
        E[K[i]]=i; if (!first_env) first_env=i
    }
}
function replace_placeholders(    k,line,value) {
    for (k in E) {
        line=E[k]
        if (index(V[line],key_marker)) {
            require(k=="CODEX_API_KEY" || k=="OPENAI_API_KEY", "Key placeholder in unexpected env")
            require(env_value(k)==key_marker, "Key placeholder must be the whole env value")
            set_value(line,key_ref)
        } else if (index(V[line],url_marker)) {
            require(k==private_env, "URL placeholder in unexpected env")
            require(env_value(k)==url_marker, "URL placeholder must be the whole env value")
            set_value(line,url_ref)
        } else if (index(V[line],model_marker)) {
            require(k ~ /^GH_AW_MODEL_/ || k=="GH_AW_INFO_MODEL" || k=="GH_AW_ENGINE_MODEL",
                "Model placeholder in unexpected env")
            require(env_value(k)==model_marker, "Model placeholder must be the whole env value")
            set_value(line,model_ref)
        }
    }
}
function patch_redaction(    k,line,n,i,name,list,extra,source) {
    require(first_env && ("GH_AW_SECRET_NAMES" in E), "Redaction step needs its generated env")
    for (k in redact_names) delete redact_names[k]
    source=env_value("GH_AW_SECRET_NAMES")
    n=split(source,redact_parts,","); list=""
    for (i=1;i<=n;i++) {
        name=redact_parts[i]
        require(name ~ /^[A-Za-z_][A-Za-z0-9_]*$/, "Unsupported redaction name list")
        require(!(name in redact_names), "Duplicate redaction Secret name")
        redact_names[name]=1; list=list (list!=""?",":"") name
    }
    extra=""
    for (i=1;i<=3;i++) {
        name=required_secrets[i]
        if (!(name in redact_names)) list=list (list!=""?",":"") name
        k="SECRET_" name
        if (k in E) require(env_value(k)==refs[name], "Conflicting redaction Secret binding")
        else extra=extra "          " k ": " refs[name] eol
    }
    if (source!=list) set_value(E["GH_AW_SECRET_NAMES"],"\047" list "\047")
    # Old CODEX/OPENAI labels are env labels. They use the same AI_API_KEY value.
    for (k in E) if (k=="SECRET_CODEX_API_KEY" || k=="SECRET_OPENAI_API_KEY") {
        source=env_value(k)
        require(source==key_ref || source==secret_ref(substr(k,8)),
            "Conflicting legacy key redaction binding")
        if (source!=key_ref) set_value(E[k],key_ref)
    }
    before[first_env]=before[first_env] extra
    redaction_jobs[job]++
}
function patch_step(start,stop,    k,i,id,phase,run,cmd,calls,flags,has_flag,s,is_redactor,model_key,model_arg,model_before,model_after,model_at,model_tail,uses_model) {
    for (k in S) delete S[k]
    for (i=start;i<stop;i++) if (T[i] && (i==start || D[i]==8)) {
        require(K[i]!="" && (i==start || !Q[i]), "Unsupported step fields")
        require(!(K[i] in S), "Duplicate step field")
        S[K[i]]=i
    }
    id=""
    if ("id" in S) {
        require(!B[S["id"]], "Block scalar step ID is unsupported")
        id=scalar(V[S["id"]])
    }
    for (i=start;i<stop;i++)
        context[i]="jobs." K[job] ".steps." (id!=""?id:"at-line-" start)
    read_env(start,stop)
    replace_placeholders()
    run=S["run"]
    if (run && !B[run] && index(V[run],"validate_multi_secret.sh") &&
        index(V[run],"CODEX_API_KEY") && index(V[run],"OPENAI_API_KEY")) {
        require(env_value("CODEX_API_KEY")==key_ref && env_value("OPENAI_API_KEY")==key_ref,
            "Key validation needs the two Markdown key placeholders")
        validations++
    }
    is_redactor=0
    if ("with" in S) for (i=S["with"]+1;i<stop;i++) {
        if (T[i] && D[i]<=8) break
        if (index(L[i],"redact_secrets.cjs")) is_redactor=1
    }
    if (is_redactor) patch_redaction()
    if (id!="agentic_execution" && id!="detection_agentic_execution") return
    require(!(id in found), "Duplicate execution step")
    found[id]=1; targets++
    phase=(id=="agentic_execution"?"agent":"detection")
    phase_jobs[phase]=job
    require(!("uses" in S), "Execution step must invoke AWF directly")
    require(first_env, "Execution env is missing")
    require(run && B[run]=="|", "Execution run must be a literal block")
    require(!("OPENAI_BASE_URL" in E) && !("ENGINE_API_TARGET" in E),
        "Remove endpoint overrides from Markdown, then recompile")
    require(env_value("CODEX_HOME")!="" && env_value("GH_AW_LLM_PROVIDER")=="openai" &&
        env_value("GH_AW_PHASE")==phase,
        "Unexpected Codex provider, home, or execution phase")
    require(env_value("CODEX_API_KEY")==key_ref && env_value("OPENAI_API_KEY")==key_ref,
        "Execution needs both Markdown key placeholders")
    require(env_value(private_env)==url_ref &&
        env_value("OPENAI_BASE_URL_ENV")==private_env,
        "Execution needs the Markdown private URL placeholder and pointer")
    model_key=(phase=="agent"?"GH_AW_MODEL_AGENT_CODEX":"GH_AW_MODEL_DETECTION_CODEX")
    require(env_value(model_key)==model_ref, "Execution needs the explicit Markdown model placeholder")
    require(!("GH_AW_MODEL_FALLBACK" in E), "Remove implicit model fallback; set both Markdown models explicitly")
    calls=0; flags=0; has_flag=0; cmd=0; uses_model=0
    model_arg=sprintf("%c",36) "{" model_key ":+ --model \"" sprintf("%c",36) model_key "\"}"
    model_after="codex exec" model_arg
    model_before="codex " sprintf("%c",36) "{" model_key ":+--model \"" sprintf("%c",36) model_key "\" }exec"
    for (i=run+1;i<BE[run];i++) {
        # Only recognize the two generator forms confirmed in gh-aw source.
        # Do not treat a variable name in arbitrary setup text as a model binding.
        model_at=index(L[i],model_after); model_tail=""
        if (model_at) model_tail=substr(L[i],model_at+length(model_after))
        else {
            model_at=index(L[i],model_before)
            if (model_at) model_tail=substr(L[i],model_at+length(model_before))
        }
        if (model_at && L[i] !~ /^[ \t]*#/) {
            uses_model++
            require(model_tail !~ /(^|[ \t])(--model([= \t]|$)|-m)/,
                "Additional model option in " id "; remove --model/-m from engine.args")
        }
        s=L[i]; flags+=gsub(/--openai-base-url-env/,"&",s)
        s=L[i]; gsub(flag,"",s)
        require(!index(s,private_env) && !index(s,"OPENAI_BASE_URL_ENV") &&
            !index(s,"baseUrlEnv"), "Conflicting private-endpoint configuration")
        if (L[i] ~ /^ *awf([ \t]|$)/) {
            calls++; cmd=i
            if (L[i] ~ /^ *awf --openai-base-url-env GH_AW_PRIVATE_OPENAI_URL --config([ \t]|$)/)
                has_flag=1
            else require(L[i] ~ /^ *awf --config([ \t]|$)/, "Unrecognized AWF invocation")
        }
    }
    require(calls==1 && flags==has_flag, "Missing, duplicate, or conflicting AWF invocation")
    require(uses_model==1, "Unrecognized Codex model argument format in " id \
        " (run starts at line " run "). Expected a supported model-env binding before or after exec." \
        " Input unchanged; provide this step's Codex command for compatibility checking.")
    if (!has_flag) sub(/awf --config/,"awf " flag " --config",L[cmd])
}
function secret_ref(name) { return sprintf("%c",36) "{{ secrets." name " }}" }
BEGIN {
    error_file=ENVIRON["GH_AW_PATCH_ERROR_FILE"]
    private_env="GH_AW_PRIVATE_OPENAI_URL"
    flag="--openai-base-url-env " private_env
    key_marker="__GH_AW_PATCH_API_KEY__"
    model_marker="ghaw-placeholder-model"
    url_marker="__GH_AW_PATCH_API_URL__"
    key_ref=secret_ref("AI_API_KEY"); model_ref=secret_ref("AI_API_MODEL"); url_ref=secret_ref("AI_API_URL")
    required_secrets[1]="AI_API_KEY"; required_secrets[2]="AI_API_MODEL"; required_secrets[3]="AI_API_URL"
    refs["AI_API_KEY"]=key_ref; refs["AI_API_MODEL"]=model_ref; refs["AI_API_URL"]=url_ref
}
{
    line=$0; cr=sub(/\r$/,"",line)
    if (NR==1) { crlf=cr; eol=(cr?"\r\n":"\n") }
    require(cr==crlf && !index(line,"\r"), "Mixed or unsupported line endings")
    require(!index(line,sprintf("%c",0)), "NUL bytes are unsupported")
    L[NR]=line
}
END {
    if (bad) exit 2
    n=NR; active=0; meta=0; manifest=0
    for (i=1;i<=n;i++) {
        line=L[i]; match(line,/^ */); depth=RLENGTH; body=substr(line,depth+1)
        if (active) {
            if (trim(line)=="" || depth>parent_indent) continue
            BE[active]=i; active=0
        }
        if (substr(line,1,18)=="# gh-aw-metadata: ") {
            require(!meta, "Duplicate metadata header"); meta=i
        }
        if (substr(line,1,18)=="# gh-aw-manifest: ") {
            require(!manifest, "Duplicate manifest header"); manifest=i
        }
        if (trim(body)=="" || substr(body,1,1)=="#") continue
        require(substr(body,1,1)!="\t", "Tab indentation is unsupported")
        require(body !~ /^(---|\.\.\.)([ \t]|$)/, "YAML document markers are unsupported")
        sequence=(substr(body,1,2)=="- "); content=(sequence?substr(body,3):body)
        key=""; value=content
        if (match(content,/^([A-Za-z_][A-Za-z0-9_.-]*|'([^']|'')*'|"([^"\\]|\\.)*"):/)) {
            size=RLENGTH; key=scalar(substr(content,1,size-1)); value=substr(content,size+1)
            require(value=="" || value ~ /^[ \t]/, "Unsupported YAML mapping")
            value=trim(value)
        } else require(sequence && trim(content)!="" && content !~ /^<<:/, "Unsupported YAML structure")
        require(key!="<<" && value !~ /^[&*!]/, "YAML aliases, anchors, tags, or merge keys are unsupported")
        clean=value; sub(/[ \t]+#.*/,"",clean); clean=trim(clean)
        require(clean !~ /^[\[{]/ || clean=="{}" || clean=="[]", "Non-empty flow collection is unsupported")
        T[i]=1; D[i]=depth; Q[i]=sequence; K[i]=key; V[i]=value
        if (clean ~ /^[|>]/) {
            require(clean ~ /^[|>][+-]?$/, "Unsupported block scalar header")
            B[i]=substr(clean,1,1); active=i; parent_indent=depth+(sequence?2:0)
        }
    }
    if (active) BE[active]=n+1
    require(meta && manifest, "Expected metadata and manifest headers")
    json(substr(L[meta],19))
    require(member("agent_id")=="\"codex\"" && member("strict")=="true",
        "Expected a strict-mode Codex workflow")
    in_jobs=0; job=0; in_steps=0; step=0
    for (i=1;i<=n;i++) if (T[i]) {
        if (D[i]==0) {
            if (step) patch_step(step,i)
            step=0; job=0; in_steps=0
            require(K[i]!="" && !Q[i] && !(K[i] in root_keys), "Unsupported or duplicate root field")
            root_keys[K[i]]=1; in_jobs=(K[i]=="jobs")
            if (in_jobs) block_map(i,"jobs")
        } else if (in_jobs && D[i]==2) {
            if (step) patch_step(step,i)
            step=0; in_steps=0
            require(K[i]!="" && !Q[i] && !(K[i] in jobs), "Unsupported or duplicate job")
            jobs[K[i]]=1; job=i; block_map(i,"job")
        } else if (in_jobs && job && D[i]==4) {
            if (step) patch_step(step,i)
            step=0
            require(K[i]!="" && !Q[i] && !((job SUBSEP K[i]) in job_keys), "Duplicate or unsupported job field")
            job_keys[job,K[i]]=1; in_steps=(K[i]=="steps")
            if (in_steps) block_map(i,"steps")
            if (K[i]=="env") patch_job_env(i,n+1)
        } else if (in_steps && D[i]==6) {
            if (step) patch_step(step,i)
            require(Q[i] && K[i]!="", "Expected generated step mapping")
            step=i
        } else if (in_jobs) {
            require(D[i]>=4 && (!in_steps || D[i]>=8), "Unsupported generated indentation")
        }
    }
    if (step) patch_step(step,n+1)
    require("agentic_execution" in found, "Missing agentic_execution")
    require(agent_only || ("detection_agentic_execution" in found),
        "Missing detection_agentic_execution; --agent-only allows workflows without detection")
    require(validations>0, "Missing Codex API-key validation step; unsupported generated workflow")
    require(redaction_jobs[phase_jobs["agent"]]>0, "Missing main-job redaction step")
    if ("detection_agentic_execution" in found)
        require(redaction_jobs[phase_jobs["detection"]]>0, "Missing detection-job redaction step")
    remaining=0
    for (i=1;i<=n;i++) {
        if (L[i] ~ /^[ \t]*#/) continue
        markers=""
        if (index(L[i],key_marker)) markers=key_marker
        if (index(L[i],model_marker)) markers=markers (markers!=""?", ":"") model_marker
        if (index(L[i],url_marker)) markers=markers (markers!=""?", ":"") url_marker
        if (markers!="") {
            print "ERROR: Placeholder remains at line " i \
                (context[i]!=""?" in " context[i]:"") ": " markers > error_file
            remaining++
        }
        require(L[i] !~ /secrets[.]CODEX_API_KEY/ && L[i] !~ /secrets[.]OPENAI_API_KEY/,
            "Unhandled legacy key Secret reference; only the three AI_API Secrets are supported")
    }
    require(!remaining, remaining " line(s) contain placeholders outside supported env entries; refusing a global replacement")
    patch_manifest(manifest)
    for (i=1;i<=n;i++) printf "%s%s%s",before[i],L[i],eol
}
AWK

run_patch() {
    GH_AW_PATCH_ERROR_FILE="$work_dir/error" \
        awk -v agent_only="$agent_only" \
        -f "$work_dir/patch.awk" < "$1" > "$2"
}
if ! run_patch "$work_dir/original" "$work_dir/patched"; then
    [ ! -f "$work_dir/error" ] || cat "$work_dir/error" >&2
    die 'Patch failed; input was not modified'
fi
if ! run_patch "$work_dir/patched" "$work_dir/verified"; then
    [ ! -f "$work_dir/error" ] || cat "$work_dir/error" >&2
    die 'Patched output failed verification; input was not modified'
fi
cmp -s "$work_dir/patched" "$work_dir/verified" ||
    die 'Internal idempotence check failed; input was not modified'
if cmp -s "$work_dir/original" "$work_dir/patched"; then
    printf '%s\n' 'OK: execution steps and manifest are already patched.'
    exit 0
fi
if [ "$check" -eq 1 ]; then
    printf '%s\n' 'NOT PATCHED: endpoint bindings, AWF flags, or manifest entry are missing.'
    exit 1
fi
# Keep file permissions and use same-filesystem rename for atomic replacement.
# This is not a locking protocol; do not run concurrent writers on this file.
cp -p "$work_dir/original" "$work_dir/replacement" || die 'Cannot prepare replacement'
cat "$work_dir/patched" > "$work_dir/replacement" || die 'Cannot write replacement'
[ -f "$lock_file" ] && [ ! -L "$lock_file" ] &&
    cmp -s "$lock_file" "$work_dir/original" ||
    die 'Input changed during patching; no replacement was made'
mv -f "$work_dir/replacement" "$lock_file" || die 'Cannot replace input'
printf '%s\n' 'Patched execution steps and manifest. No Git operations performed.'
