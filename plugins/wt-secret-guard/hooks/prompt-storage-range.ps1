$path = $args[0]
$offset = [int64]$args[1]
$length = [int]$args[2]
$mode = $args[3]
$stream = [IO.FileStream]::new($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
try {
  $null = $stream.Seek($offset, [IO.SeekOrigin]::Begin)
  if ($mode -eq 'read') {
    $bytes = New-Object byte[] $length
    $read = $stream.Read($bytes, 0, $length)
    [Console]::Write([Convert]::ToBase64String($bytes, 0, $read))
  } else {
    $bytes = [Convert]::FromBase64String($args[4])
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
  }
} finally {
  $stream.Dispose()
}
