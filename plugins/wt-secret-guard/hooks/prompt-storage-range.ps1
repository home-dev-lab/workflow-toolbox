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
    $expected = [Convert]::FromBase64String($args[5])
    $expectedSize = [int64]$args[6]
    $expectedPrefix = [Convert]::FromBase64String($args[7])
    if ($stream.Length -ne $expectedSize) { exit 6 }
    $currentPrefix = New-Object byte[] $expectedPrefix.Length
    $null = $stream.Seek(0, [IO.SeekOrigin]::Begin)
    $prefixRead = $stream.Read($currentPrefix, 0, $currentPrefix.Length)
    if ($prefixRead -ne $expectedPrefix.Length -or [Convert]::ToBase64String($currentPrefix) -ne $args[7]) { exit 3 }
    $current = New-Object byte[] $length
    $null = $stream.Seek($offset, [IO.SeekOrigin]::Begin)
    $currentRead = $stream.Read($current, 0, $length)
    if ($currentRead -ne $length -or [Convert]::ToBase64String($current) -ne $args[5]) { exit 3 }
    $null = $stream.Seek($offset, [IO.SeekOrigin]::Begin)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    $verify = New-Object byte[] $bytes.Length
    $null = $stream.Seek($offset, [IO.SeekOrigin]::Begin)
    $verifyRead = $stream.Read($verify, 0, $verify.Length)
    if ($verifyRead -ne $bytes.Length -or [Convert]::ToBase64String($verify) -ne $args[4]) { exit 5 }
  }
} finally {
  $stream.Dispose()
}
