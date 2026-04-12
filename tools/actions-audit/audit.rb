#!/usr/bin/env ruby

require "base64"
require "fileutils"
require "json"
require "open3"
require "pathname"
require "set"
require "time"
require "uri"
require "yaml"

class CommandError < StandardError; end

ROOT = Pathname.new(__dir__).join("..", "..").expand_path
MANIFEST_PATH = Pathname.new(__dir__).join("repos.yml").expand_path
OUTPUT_ROOT = ROOT.join("audit")
LIVE_CALLERS_DIR = OUTPUT_ROOT.join("inventory", "live-callers")
SHARED_CONTRACTS_DIR = OUTPUT_ROOT.join("inventory", "shared-contracts")
GITHUB_CONFIG_DIR = OUTPUT_ROOT.join("inventory", "github-config")
REPORTS_DIR = OUTPUT_ROOT.join("reports")
BY_TYPE_DIR = OUTPUT_ROOT.join("by-type")

BUILT_IN_SECRETS = Set.new(["GITHUB_TOKEN"])
SHARED_REPO_PREFIX = "VeamStudios/.github/"
LEGACY_ACTIONS_PREFIX = "VeamStudios/Actions/"

def run_cmd(*cmd)
  stdout, stderr, status = Open3.capture3(*cmd, chdir: ROOT.to_s)
  return stdout if status.success?

  detail = stderr.strip
  detail = stdout.strip if detail.empty?
  raise CommandError, "Command failed: #{cmd.join(' ')}\n#{detail}"
end

def write_json(path, payload)
  FileUtils.mkdir_p(Pathname(path).dirname)
  File.write(path, JSON.pretty_generate(payload) + "\n")
end

def write_text(path, text)
  FileUtils.mkdir_p(Pathname(path).dirname)
  File.write(path, text)
end

def encode_ref(ref)
  URI.encode_www_form_component(ref.to_s)
end

def parse_yaml_document(text)
  patched = text.gsub(/^on:/, '"on":')
  parsed = YAML.safe_load(patched, aliases: true)
  parsed.is_a?(Hash) ? parsed : {}
rescue Psych::Exception => e
  { "__parse_error__" => e.message }
end

def trigger_names(on_node)
  case on_node
  when String
    [on_node]
  when Array
    on_node.map(&:to_s)
  when Hash
    on_node.keys.map(&:to_s)
  else
    []
  end
end

def workflow_category(path)
  stem = File.basename(path, File.extname(path)).downcase
  return "qa" if ["qa", "qa-automation", "qa-pipeline"].include?(stem)
  return "pr-title-check" if stem.include?("pr-title")
  return "issue-bot" if stem.include?("issue")
  return "pr-build" if ["pr-build", "ios", "pr-ios-build"].include?(stem)
  return "deploy-dev" if stem == "deploy-dev"
  return "deploy-beta" if stem == "deploy-beta"
  return "deploy-production" if stem == "deploy-production"
  return "hotfix-prepare" if stem == "hotfix-prepare"
  return "hotfix-deploy" if stem == "hotfix-deploy"
  return "pr-notion-docs-sync" if stem.include?("notion")
  return "update-models" if stem.match?(/\Aupdate-.*models\z/)
  return "release" if ["release", "ios-tagged-release", "changelog"].include?(stem)
  return "ci" if ["ci", "check"].include?(stem)
  return "validate-and-test" if stem.include?("validate-and-test")
  return "deploy" if stem == "_deploy" || stem == "deploy"
  stem
end

def normalize_environment(environment)
  case environment
  when String
    environment
  when Hash
    environment["name"] || environment[:name] || JSON.generate(environment)
  else
    nil
  end
end

def schema_entries(node, type: nil)
  return [] unless node.is_a?(Hash)

  node.map do |name, config|
    if config.is_a?(Hash)
      {
        "name" => name.to_s,
        "type" => config["type"] || type,
        "required" => config.fetch("required", false),
        "default" => config["default"],
        "description" => config["description"],
        "value" => config["value"]
      }
    else
      {
        "name" => name.to_s,
        "type" => type,
        "required" => false,
        "default" => nil,
        "description" => nil,
        "value" => config
      }
    end
  end.sort_by { |entry| entry["name"] }
end

def extract_job_calls(data)
  jobs = data["jobs"]
  return [] unless jobs.is_a?(Hash)

  jobs.map do |job_name, job|
    next unless job.is_a?(Hash)

    secrets = job["secrets"]
    {
      "job_name" => job_name.to_s,
      "uses" => job["uses"],
      "with_keys" => job["with"].is_a?(Hash) ? job["with"].keys.map(&:to_s).sort : [],
      "with" => job["with"].is_a?(Hash) ? job["with"].transform_keys(&:to_s) : nil,
      "secret_mode" => secrets == "inherit" ? "inherit" : (secrets.is_a?(Hash) ? "explicit" : "none"),
      "mapped_secret_names" => secrets.is_a?(Hash) ? secrets.keys.map(&:to_s).sort : [],
      "environment" => normalize_environment(job["environment"])
    }
  end.compact
end

def extract_expression_references(text)
  {
    "secrets" => text.scan(/\bsecrets\.([A-Za-z0-9_-]+)/).flatten.uniq.sort,
    "vars" => text.scan(/\bvars\.([A-Za-z0-9_-]+)/).flatten.uniq.sort
  }
end

def fetch_text_from_blob(client, owner, repo, sha)
  blob = client.api_json("repos/#{owner}/#{repo}/git/blobs/#{sha}")
  content = blob.fetch("content", "")
  blob.fetch("encoding") == "base64" ? Base64.decode64(content) : content
end

def shared_repo_use?(value)
  value.to_s.start_with?(SHARED_REPO_PREFIX)
end

def legacy_actions_use?(value)
  value.to_s.start_with?(LEGACY_ACTIONS_PREFIX)
end

def external_use?(value)
  value.to_s.include?("/") && !value.to_s.start_with?("./")
end

def local_use?(value)
  value.to_s.start_with?("./")
end

def normalize_uses(value)
  value.to_s.strip
end

def use_target_and_ref(value)
  target, ref = normalize_uses(value).split("@", 2)
  {
    "target" => target,
    "ref" => ref
  }
end

def source_ref_label(repo_entry)
  source = repo_entry.fetch("source")
  source["label"] || source["ref"] || source["sha"]
end

def source_fetch_ref(repo_entry)
  source = repo_entry.fetch("source")
  source["sha"] || source["ref"]
end

def source_blob_ref(repo_entry)
  source = repo_entry.fetch("source")
  source["ref"] || source["sha"]
end

def github_blob_url(repo_entry, path)
  "#{repo_entry.fetch('url')}/blob/#{source_blob_ref(repo_entry)}/#{path}"
end

def analyze_workflow_document(repo_entry, path, text, sha:, source_url:)
  data = parse_yaml_document(text)
  refs = extract_expression_references(text)
  on_node = data["on"]
  workflow_call = on_node.is_a?(Hash) ? on_node["workflow_call"] : nil
  job_calls = extract_job_calls(data)
  uses_values = job_calls.map { |job| job["uses"] }.compact.map { |value| normalize_uses(value) }.uniq.sort
  environments = job_calls.map { |job| job["environment"] }.compact.uniq.sort
  declared_secrets = schema_entries(workflow_call.is_a?(Hash) ? workflow_call["secrets"] : nil, type: "secret")
  declared_secret_names = declared_secrets.map { |entry| entry["name"] }
  structure_key = data["__parse_error__"] ? nil : JSON.generate(canonicalize_structure(data, top_level: true))

  {
    "path" => path,
    "source_url" => source_url,
    "source_blob_sha" => sha,
    "filename" => File.basename(path),
    "workflow_name" => data["name"] || File.basename(path),
    "category" => workflow_category(path),
    "parse_error" => data["__parse_error__"],
    "triggers" => trigger_names(on_node),
    "job_calls" => job_calls,
    "uses_values" => uses_values,
    "external_uses" => uses_values.select { |value| external_use?(value) },
    "local_uses" => uses_values.select { |value| local_use?(value) },
    "shared_repo_uses" => uses_values.select { |value| shared_repo_use?(value) },
    "legacy_actions_uses" => uses_values.select { |value| legacy_actions_use?(value) },
    "referenced_secrets" => refs["secrets"],
    "referenced_vars" => refs["vars"],
    "workflow_call" => workflow_call.is_a?(Hash) ? {
      "inputs" => schema_entries(workflow_call["inputs"], type: "input"),
      "secrets" => declared_secrets,
      "outputs" => schema_entries(workflow_call["outputs"], type: "output")
    } : nil,
    "implicit_secret_dependencies" => (refs["secrets"] - declared_secret_names - BUILT_IN_SECRETS.to_a).sort,
    "implicit_var_dependencies" => refs["vars"],
    "environments" => environments,
    "top_level_concurrency" => data["concurrency"],
    "structure_key" => structure_key
  }
end

def analyze_action_document(path, text)
  data = parse_yaml_document(text)
  {
    "path" => path,
    "filename" => File.basename(path),
    "name" => data["name"] || File.basename(path),
    "parse_error" => data["__parse_error__"],
    "inputs" => schema_entries(data["inputs"], type: "input"),
    "outputs" => schema_entries(data["outputs"], type: "output"),
    "runs_using" => data["runs"].is_a?(Hash) ? data["runs"]["using"] : nil
  }
end

def workflow_signature(workflow)
  {
    "triggers" => workflow["triggers"].sort,
    "shared_repo_uses" => workflow["shared_repo_uses"].sort,
    "legacy_actions_uses" => workflow["legacy_actions_uses"].sort,
    "local_uses" => workflow["local_uses"].sort,
    "job_secret_modes" => workflow["job_calls"].map { |job| job["secret_mode"] }.uniq.sort,
    "mapped_secret_names" => workflow["job_calls"].flat_map { |job| job["mapped_secret_names"] }.uniq.sort,
    "with_keys" => workflow["job_calls"].flat_map { |job| job["with_keys"] }.uniq.sort,
    "environments" => workflow["environments"].sort
  }
end

def signature_key(workflow)
  JSON.generate(workflow_signature(workflow))
end

def comparison_scope(category, family)
  return "cross-repo" if ["pr-title-check", "qa", "issue-bot", "pr-notion-docs-sync"].include?(category)
  return "ios-family" if family == "ios"
  return "web-family" if family == "web"
  return "backend-family" if family == "backend"
  return "models-family" if family == "models"
  "repo-family"
end

def baseline_score(workflow)
  score = 0
  score += 100 if workflow["shared_repo_uses"].any?
  score += 50 if workflow["external_uses"].any? && workflow["legacy_actions_uses"].empty?
  score += 15 if workflow["job_calls"].any? { |job| job["secret_mode"] == "inherit" }
  score += 5 if workflow["workflow_call"].nil?
  score -= 20 if workflow["legacy_actions_uses"].any?
  score += workflow["job_calls"].length
  score
end

def signature_summary(workflow)
  parts = []
  parts << "triggers=#{workflow['triggers'].join(',')}" unless workflow["triggers"].empty?
  parts << "shared=#{workflow['shared_repo_uses'].join(',')}" unless workflow["shared_repo_uses"].empty?
  parts << "legacy=#{workflow['legacy_actions_uses'].join(',')}" unless workflow["legacy_actions_uses"].empty?
  parts << "local=#{workflow['local_uses'].join(',')}" unless workflow["local_uses"].empty?
  secret_modes = workflow["job_calls"].map { |job| job["secret_mode"] }.uniq.sort
  parts << "secrets=#{secret_modes.join(',')}" unless secret_modes.empty?
  mapped_secrets = workflow["job_calls"].flat_map { |job| job["mapped_secret_names"] }.uniq.sort
  parts << "mapped_secrets=#{mapped_secrets.join(',')}" unless mapped_secrets.empty?
  with_keys = workflow["job_calls"].flat_map { |job| job["with_keys"] }.uniq.sort
  parts << "with=#{with_keys.join(',')}" unless with_keys.empty?
  parts << "environments=#{workflow['environments'].join(',')}" unless workflow["environments"].empty?
  parts.join(" | ")
end

def display_list(values)
  values = Array(values).map(&:to_s)
  values.empty? ? "(none)" : values.join(", ")
end

def normalized_snapshot_text(text)
  text.to_s.gsub("\r\n", "\n").lines.map(&:rstrip).join("\n").sub(/\n*\z/, "\n")
end

def canonicalize_structure(value, top_level: false)
  case value
  when Hash
    normalized = value.each_with_object({}) do |(key, child), memo|
      string_key = key.to_s
      next if top_level && string_key == "name"
      next if string_key == "__parse_error__"

      memo[string_key] = canonicalize_structure(child)
    end

    normalized.keys.sort.each_with_object({}) do |key, memo|
      memo[key] = normalized[key]
    end
  when Array
    value.map { |child| canonicalize_structure(child) }
  else
    value
  end
end

def scope_folder_name(scope)
  case scope
  when "cross-repo"
    "cross-repo"
  when "ios-family"
    "ios"
  when "web-family"
    "web"
  when "backend-family"
    "backend"
  when "models-family"
    "models"
  else
    scope.gsub("/", "-")
  end
end

def category_folder_name(category)
  case category
  when "qa"
    "qa-pipeline"
  else
    category.gsub("/", "--")
  end
end

def workflow_text_key(repo_key, path)
  "#{repo_key}:#{path}"
end

def snapshot_filename_for_workflow(workflow, category, used_filenames)
  ext = File.extname(workflow.fetch("path"))
  ext = ".yml" if ext.empty?
  base = "#{workflow.fetch('repo_key')}__#{category_folder_name(category)}"
  filename = "#{base}#{ext}"

  if used_filenames.include?(filename)
    stem = File.basename(workflow.fetch("path"), File.extname(workflow.fetch("path"))).downcase.gsub(/[^a-z0-9]+/, "-").gsub(/\A-+|-+\z/, "")
    filename = "#{base}__#{stem}#{ext}"
  end

  used_filenames << filename
  filename
end

def display_diff_value(value)
  string =
    case value
    when String
      value
    when NilClass
      "null"
    else
      JSON.generate(value)
    end

  string = "(empty)" if string.empty?
  string.length > 140 ? "#{string[0, 137]}..." : string
end

def structure_path_label(parts)
  return "(root)" if parts.empty?

  parts.each_with_object(+"") do |part, memo|
    if part.is_a?(Integer)
      memo << "[#{part}]"
    else
      memo << "." unless memo.empty?
      memo << part.to_s
    end
  end
end

def structure_deltas(current, baseline, path = [])
  if current.is_a?(Hash) && baseline.is_a?(Hash)
    keys = (current.keys + baseline.keys).uniq.sort
    return keys.flat_map do |key|
      if !current.key?(key)
        [{ "path" => structure_path_label(path + [key]), "current" => "(missing)", "baseline" => display_diff_value(baseline[key]) }]
      elsif !baseline.key?(key)
        [{ "path" => structure_path_label(path + [key]), "current" => display_diff_value(current[key]), "baseline" => "(missing)" }]
      else
        structure_deltas(current[key], baseline[key], path + [key])
      end
    end
  end

  if current.is_a?(Array) && baseline.is_a?(Array)
    return [] if current == baseline

    scalar_array = current.all? { |value| !value.is_a?(Hash) && !value.is_a?(Array) } &&
      baseline.all? { |value| !value.is_a?(Hash) && !value.is_a?(Array) }
    if scalar_array
      return [{ "path" => structure_path_label(path), "current" => display_diff_value(current), "baseline" => display_diff_value(baseline) }]
    end

    max_length = [current.length, baseline.length].max
    return max_length.times.flat_map do |index|
      if index >= current.length
        [{ "path" => structure_path_label(path + [index]), "current" => "(missing)", "baseline" => display_diff_value(baseline[index]) }]
      elsif index >= baseline.length
        [{ "path" => structure_path_label(path + [index]), "current" => display_diff_value(current[index]), "baseline" => "(missing)" }]
      else
        structure_deltas(current[index], baseline[index], path + [index])
      end
    end
  end

  return [] if current == baseline

  [{ "path" => structure_path_label(path), "current" => display_diff_value(current), "baseline" => display_diff_value(baseline) }]
end

class GitHubClient
  def api(endpoint)
    run_cmd("gh", "api", endpoint)
  end

  def api_json(endpoint)
    JSON.parse(api(endpoint))
  end
end

# ---------------------------------------------------------------------------
# Data collection
# ---------------------------------------------------------------------------

manifest = YAML.safe_load(File.read(MANIFEST_PATH), aliases: true)
FileUtils.rm_rf(OUTPUT_ROOT)
FileUtils.mkdir_p(OUTPUT_ROOT)
client = GitHubClient.new
generated_at = Time.now.utc.iso8601
org = manifest.fetch("org")

live_inventory = {
  "generated_at" => generated_at,
  "org" => org,
  "repos" => []
}
workflow_texts = {}
workflow_structures = {}
shared_workflow_texts = {}

manifest.fetch("repos").each do |repo_entry|
  owner = repo_entry.fetch("owner")
  repo_name = repo_entry.fetch("name")
  ref = source_fetch_ref(repo_entry)
  encoded_ref = encode_ref(ref)
  tree = client.api_json("repos/#{owner}/#{repo_name}/git/trees/#{encoded_ref}?recursive=1")
  nodes = tree.fetch("tree", [])
  workflow_nodes = nodes.select do |node|
    node["type"] == "blob" && node["path"].start_with?(".github/workflows/") && node["path"].match?(/\.ya?ml\z/)
  end
  action_nodes = nodes.select do |node|
    node["type"] == "blob" && node["path"].match?(%r{\A\.github/actions/.+/action\.ya?ml\z})
  end

  workflows = workflow_nodes.sort_by { |node| node["path"] }.map do |node|
    text = fetch_text_from_blob(client, owner, repo_name, node.fetch("sha"))
    workflow_texts[workflow_text_key(repo_entry.fetch("key"), node.fetch("path"))] = text
    workflow_structures[workflow_text_key(repo_entry.fetch("key"), node.fetch("path"))] = canonicalize_structure(parse_yaml_document(text), top_level: true)
    analyze_workflow_document(
      repo_entry,
      node.fetch("path"),
      text,
      sha: node.fetch("sha"),
      source_url: github_blob_url(repo_entry, node.fetch("path"))
    )
  end

  actions = action_nodes.sort_by { |node| node["path"] }.map do |node|
    text = fetch_text_from_blob(client, owner, repo_name, node.fetch("sha"))
    analyze_action_document(node.fetch("path"), text).merge(
      "source_url" => github_blob_url(repo_entry, node.fetch("path")),
      "source_blob_sha" => node.fetch("sha")
    )
  end

  repo_payload = repo_entry.merge(
    "source_label" => source_ref_label(repo_entry),
    "fetched_ref" => ref,
    "workflow_count" => workflows.length,
    "action_count" => actions.length,
    "workflows" => workflows,
    "actions" => actions
  )
  live_inventory["repos"] << repo_payload
  write_json(LIVE_CALLERS_DIR.join("#{repo_entry.fetch('key')}.json"), repo_payload)
end

shared_workflow_paths = Dir.glob(ROOT.join(".github", "workflows", "*.{yml,yaml}").to_s).sort
shared_action_paths = Dir.glob(ROOT.join(".github", "actions", "**", "action.{yml,yaml}").to_s).sort
caller_template_paths = Dir.glob(ROOT.join("caller-templates", "*.{yml,yaml}").to_s).sort

shared_inventory = {
  "generated_at" => generated_at,
  "workflows" => shared_workflow_paths.map do |path|
    relative = Pathname.new(path).relative_path_from(ROOT).to_s
    shared_workflow_texts[relative] = File.read(path)
    analyze_workflow_document(
      {
        "url" => "https://github.com/VeamStudios/.github",
        "source" => { "ref" => "main" }
      },
      relative,
      shared_workflow_texts[relative],
      sha: nil,
      source_url: "https://github.com/VeamStudios/.github/blob/main/#{relative}"
    )
  end,
  "actions" => shared_action_paths.map do |path|
    relative = Pathname.new(path).relative_path_from(ROOT).to_s
    analyze_action_document(relative, File.read(path)).merge(
      "source_url" => "https://github.com/VeamStudios/.github/blob/main/#{relative}"
    )
  end,
  "caller_templates" => caller_template_paths.map do |path|
    relative = Pathname.new(path).relative_path_from(ROOT).to_s
    analyze_workflow_document(
      {
        "url" => "https://github.com/VeamStudios/.github",
        "source" => { "ref" => "main" }
      },
      relative,
      File.read(path),
      sha: nil,
      source_url: "https://github.com/VeamStudios/.github/blob/main/#{relative}"
    )
  end
}

write_json(SHARED_CONTRACTS_DIR.join("shared-contracts.json"), shared_inventory)

config_inventory = {
  "generated_at" => generated_at,
  "org" => org,
  "org_access" => {},
  "repos" => []
}

{
  "secrets" => "orgs/#{org}/actions/secrets",
  "variables" => "orgs/#{org}/actions/variables"
}.each do |kind, endpoint|
  begin
    payload = client.api_json(endpoint)
    config_inventory["org_access"][kind] = {
      "accessible" => true,
      "count" => payload["total_count"]
    }
  rescue CommandError => e
    config_inventory["org_access"][kind] = {
      "accessible" => false,
      "error" => e.message.lines.last.to_s.strip
    }
  end
end

manifest.fetch("repos").each do |repo_entry|
  owner = repo_entry.fetch("owner")
  repo_name = repo_entry.fetch("name")
  repo_key = repo_entry.fetch("key")

  repo_secrets = client.api_json("repos/#{owner}/#{repo_name}/actions/secrets")
  repo_variables = client.api_json("repos/#{owner}/#{repo_name}/actions/variables")
  environments = client.api_json("repos/#{owner}/#{repo_name}/environments").fetch("environments", [])

  env_payloads = environments.sort_by { |env| env["name"] }.map do |environment|
    env_name = environment.fetch("name")
    encoded_env = encode_ref(env_name)
    secrets_payload = client.api_json("repos/#{owner}/#{repo_name}/environments/#{encoded_env}/secrets")
    vars_payload = client.api_json("repos/#{owner}/#{repo_name}/environments/#{encoded_env}/variables")
    {
      "name" => env_name,
      "html_url" => environment["html_url"],
      "repo_secrets" => secrets_payload.fetch("secrets", []).map { |secret| secret["name"] }.sort,
      "repo_variables" => vars_payload.fetch("variables", []).map { |var| var["name"] }.sort
    }
  end

  payload = {
    "key" => repo_key,
    "repo" => "#{owner}/#{repo_name}",
    "family" => repo_entry.fetch("family"),
    "product" => repo_entry.fetch("product"),
    "source_label" => source_ref_label(repo_entry),
    "repo_secrets" => repo_secrets.fetch("secrets", []).map { |secret| secret["name"] }.sort,
    "repo_variables" => repo_variables.fetch("variables", []).map { |var| var["name"] }.sort,
    "environments" => env_payloads
  }
  config_inventory["repos"] << payload
  write_json(GITHUB_CONFIG_DIR.join("#{repo_key}.json"), payload)
end

write_json(GITHUB_CONFIG_DIR.join("org-access.json"), config_inventory["org_access"])
write_json(GITHUB_CONFIG_DIR.join("github-config.json"), config_inventory)

shared_workflow_targets = shared_inventory.fetch("workflows").map { |workflow| workflow["filename"] }.to_set
live_shared_target_counts = Hash.new(0)
live_inventory.fetch("repos").each do |repo|
  repo.fetch("workflows").each do |workflow|
    workflow.fetch("shared_repo_uses").each do |use_value|
      target = use_target_and_ref(use_value)["target"]
      live_shared_target_counts[target] += 1
    end
  end
end

template_drift_items = []
shared_inventory.fetch("caller_templates").each do |template|
  template.fetch("shared_repo_uses").each do |use_value|
    parsed_use = use_target_and_ref(use_value)
    target_filename = File.basename(parsed_use["target"])
    next if shared_workflow_targets.include?(target_filename)

    suggestion =
      case target_filename
      when "qa-automation.yml", "auto-merge.yml"
        ".github/workflows/qa-pipeline.yml"
      else
        nil
      end

    template_drift_items << {
      "template" => template["path"],
      "missing_target" => parsed_use["target"],
      "missing_ref" => parsed_use["ref"],
      "suggested_target" => suggestion,
      "live_usage_count" => live_shared_target_counts[parsed_use["target"]]
    }
  end
end

repo_summaries = live_inventory.fetch("repos").map do |repo|
  workflows = repo.fetch("workflows")
  {
    "key" => repo.fetch("key"),
    "repo" => "#{repo.fetch('owner')}/#{repo.fetch('name')}",
    "family" => repo.fetch("family"),
    "product" => repo.fetch("product"),
    "source_label" => repo.fetch("source_label"),
    "workflow_count" => workflows.length,
    "shared_workflow_calls" => workflows.sum { |workflow| workflow.fetch("shared_repo_uses").length },
    "legacy_actions_calls" => workflows.sum { |workflow| workflow.fetch("legacy_actions_uses").length },
    "local_reusable_calls" => workflows.sum { |workflow| workflow.fetch("local_uses").length },
    "entry_workflows" => workflows.reject { |workflow| workflow.fetch("filename").start_with?("_") }.map { |workflow| workflow.fetch("filename") }.sort
  }
end

# ---------------------------------------------------------------------------
# Group workflows by scope / category
# ---------------------------------------------------------------------------

grouped_workflows = live_inventory.fetch("repos").flat_map do |repo|
  repo.fetch("workflows").map do |workflow|
    workflow.merge(
      "repo_key" => repo.fetch("key"),
      "repo_name" => "#{repo.fetch('owner')}/#{repo.fetch('name')}",
      "family" => repo.fetch("family"),
      "product" => repo.fetch("product"),
      "source_label" => repo.fetch("source_label")
    )
  end
end.reject do |workflow|
  workflow.fetch("filename").start_with?("_")
end.group_by do |workflow|
  category = workflow.fetch("category")
  scope = comparison_scope(category, workflow.fetch("family"))
  [scope, category]
end

# ---------------------------------------------------------------------------
# Determine baseline per group
# ---------------------------------------------------------------------------

canonical_patterns = []
baseline_workflows = {}
grouped_workflows.each do |(scope, category), workflows|
  next if workflows.empty?
  signature_groups = workflows.group_by { |workflow| signature_key(workflow) }
  baseline_group = signature_groups.values.max_by do |grouped|
    [grouped.length, grouped.map { |workflow| baseline_score(workflow) }.max]
  end
  baseline_workflow = baseline_group.max_by { |workflow| baseline_score(workflow) }
  baseline_workflows[[scope, category]] = baseline_workflow
  canonical_patterns << {
    "category" => category,
    "scope" => scope,
    "family" => baseline_workflow.fetch("family"),
    "example_repo" => baseline_workflow.fetch("repo_name"),
    "example_path" => baseline_workflow.fetch("path"),
    "recommended_uses" => (baseline_workflow.fetch("shared_repo_uses") + baseline_workflow.fetch("external_uses").reject { |value| legacy_actions_use?(value) }).uniq.sort,
    "legacy_uses" => baseline_workflow.fetch("legacy_actions_uses"),
    "triggers" => baseline_workflow.fetch("triggers"),
    "with_keys" => baseline_workflow.fetch("job_calls").flat_map { |job| job.fetch("with_keys") }.uniq.sort,
    "mapped_secret_names" => baseline_workflow.fetch("job_calls").flat_map { |job| job.fetch("mapped_secret_names") }.uniq.sort,
    "environments" => baseline_workflow.fetch("environments")
  }
end
canonical_patterns.sort_by! { |pattern| [pattern.fetch("scope"), pattern.fetch("category")] }

# ---------------------------------------------------------------------------
# Generate by-type snapshots and difference summaries
# ---------------------------------------------------------------------------

FileUtils.mkdir_p(BY_TYPE_DIR)

index_lines = []
index_lines << "# Workflow Snapshots by Type"
index_lines << ""
index_lines << "Browse each folder to compare raw YAML snapshots and see a summary of differences."
index_lines << ""
index_lines << "| Folder | Repos | Snapshots | Differences |"
index_lines << "| --- | --- | --- | --- |"

grouped_workflow_keys = grouped_workflows.keys.sort_by { |scope, category| [scope_folder_name(scope), category_folder_name(category)] }
grouped_workflow_keys.each do |scope, category|
  workflows = grouped_workflows.fetch([scope, category]).sort_by { |w| [w.fetch("repo_name"), w.fetch("path")] }
  next if workflows.empty?

  folder_path = BY_TYPE_DIR.join(scope_folder_name(scope), category_folder_name(category))
  snapshots_dir = folder_path.join("snapshots")
  FileUtils.mkdir_p(snapshots_dir)

  baseline_workflow = baseline_workflows.fetch([scope, category])
  used_snapshot_filenames = Set.new
  snapshot_filenames = {}

  workflows.each do |workflow|
    filename = snapshot_filename_for_workflow(workflow, category, used_snapshot_filenames)
    snapshot_filenames[[workflow.fetch("repo_name"), workflow.fetch("path")]] = filename
    text = workflow_texts[workflow_text_key(workflow.fetch("repo_key"), workflow.fetch("path"))]
    write_text(snapshots_dir.join(filename), text)
  end

  baseline_structure_key = baseline_workflow.fetch("structure_key")
  baseline_structure = workflow_structures[workflow_text_key(baseline_workflow.fetch("repo_key"), baseline_workflow.fetch("path"))]
  baseline_snapshot = snapshot_filenames[[baseline_workflow.fetch("repo_name"), baseline_workflow.fetch("path")]]

  matching = workflows.select { |w| w.fetch("structure_key") == baseline_structure_key }
  differing = workflows.reject { |w| w.fetch("structure_key") == baseline_structure_key }

  diff_lines = []
  diff_lines << "# #{category_folder_name(category)} -- Differences"
  diff_lines << ""
  diff_lines << "Baseline: `#{baseline_snapshot}` (#{baseline_workflow.fetch('repo_name')})"
  diff_lines << ""
  diff_lines << "## Identical"
  diff_lines << ""
  if matching.empty?
    diff_lines << "- (none)"
  else
    matching.each do |w|
      diff_lines << "- #{w.fetch('repo_key')} (#{w.fetch('repo_name')})"
    end
  end
  diff_lines << ""

  if differing.empty?
    diff_lines << "All snapshots are structurally identical."
  else
    diff_lines << "## Different"
    diff_lines << ""
    differing.each do |workflow|
      structure = workflow_structures[workflow_text_key(workflow.fetch("repo_key"), workflow.fetch("path"))]
      deltas = structure_deltas(structure, baseline_structure)
      snapshot = snapshot_filenames[[workflow.fetch("repo_name"), workflow.fetch("path")]]

      diff_lines << "### #{workflow.fetch('repo_key')} (#{workflow.fetch('repo_name')})"
      diff_lines << "Snapshot: `#{snapshot}`"
      diff_lines << ""
      if deltas.empty?
        diff_lines << "- Structure differs but no field-level deltas could be extracted. Compare snapshots manually."
      else
        deltas.each do |delta|
          diff_lines << "- `#{delta['path']}`: #{delta['current']} -> #{delta['baseline']}"
        end
      end
      diff_lines << ""
    end
  end

  write_text(folder_path.join("differences.md"), diff_lines.join("\n") + "\n")

  repo_keys = workflows.map { |w| w.fetch("repo_key") }.uniq
  index_lines << "| `#{scope_folder_name(scope)}/#{category_folder_name(category)}` | #{repo_keys.map { |k| "`#{k}`" }.join(', ')} | #{workflows.length} | #{differing.any? ? 'yes' : 'no'} |"
end

write_text(BY_TYPE_DIR.join("README.md"), index_lines.join("\n") + "\n")

# ---------------------------------------------------------------------------
# Analysis summary
# ---------------------------------------------------------------------------

analysis = {
  "generated_at" => generated_at,
  "repo_summaries" => repo_summaries,
  "canonical_patterns" => canonical_patterns,
  "org_access" => config_inventory.fetch("org_access")
}
write_json(OUTPUT_ROOT.join("inventory", "analysis.json"), analysis)

# ---------------------------------------------------------------------------
# Consistency report
# ---------------------------------------------------------------------------

report_lines = []
report_lines << "# Cross-Repo Workflow Consistency Report"
report_lines << ""
report_lines << "Generated at `#{generated_at}`."
report_lines << "Source manifest: `tools/actions-audit/repos.yml`."
report_lines << ""
report_lines << "## Repo Summary"
report_lines << ""
report_lines << "| Repo | Family | Source | Workflows | Shared Calls | Legacy Calls | Local Calls |"
report_lines << "| --- | --- | --- | --- | --- | --- | --- |"
repo_summaries.each do |summary|
  report_lines << "| #{summary['repo']} | #{summary['family']} | #{summary['source_label']} | #{summary['workflow_count']} | #{summary['shared_workflow_calls']} | #{summary['legacy_actions_calls']} | #{summary['local_reusable_calls']} |"
end
report_lines << ""
report_lines << "## Key Findings"
report_lines << ""

legacy_repos = repo_summaries.select { |s| s["legacy_actions_calls"] > 0 }
if legacy_repos.any?
  report_lines << "- Legacy `VeamStudios/Actions` usage: #{legacy_repos.map { |s| s['repo'] }.join(', ')}."
end

shared_contract_gaps = shared_inventory.fetch("workflows").select { |w| w["workflow_call"] && w.fetch("implicit_secret_dependencies").any? }
if shared_contract_gaps.any?
  report_lines << "- Reusable workflows with undeclared secret dependencies: #{shared_contract_gaps.map { |w| File.basename(w['path']) }.uniq.join(', ')}."
end

if template_drift_items.any?
  report_lines << "- Caller templates reference missing reusable workflows: #{template_drift_items.map { |i| i['missing_target'] }.uniq.join(', ')}."
end

org_secret_access = config_inventory.dig("org_access", "secrets", "accessible")
org_variable_access = config_inventory.dig("org_access", "variables", "accessible")
unless org_secret_access && org_variable_access
  report_lines << "- Org-level secrets/variables could not be inventoried with the current token."
end

report_lines << ""
report_lines << "## Review"
report_lines << ""
report_lines << "Browse `audit/by-type/` for snapshots grouped by workflow type."
report_lines << "Each folder contains raw YAML snapshots and a `differences.md` summary."
report_lines << "To walk through differences interactively, ask the AI to review a specific folder."

write_text(REPORTS_DIR.join("consistency-report.md"), report_lines.join("\n") + "\n")
